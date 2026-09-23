import { spawn } from "node:child_process";
import {
    type NativeHistoryMessage,
    type NativeMessageActivity,
    type NativeSessionHistory,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_MESSAGE_LIMIT,
    SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { AcpExecutionError } from "../acp/acp-error.ts";
import { nativeSessionIdSchema } from "../acp/native-session.ts";
import type { AcpAgentDefinition } from "../agent-catalog/local-agent.ts";
import { revalidateExecutable, stopProcessTree } from "../process/executable.ts";
import { embedLocalHistoryImages } from "./history-images.ts";

const responseSchema = z.union([
    z.object({
        id: z.number(),
        error: z.object({ code: z.number(), message: z.string() }),
    }),
    z.object({ id: z.number(), result: z.unknown() }),
    z.object({ method: z.string() }),
]);
const threadSchema = z.object({
    thread: z.object({
        id: nativeSessionIdSchema,
        cwd: z
            .string()
            .min(1)
            .max(2_048)
            .refine((path) => !path.includes("\0")),
    }),
});
const turnsSchema = z.object({
    data: z
        .array(
            z.object({
                error: z.unknown().nullish(),
                items: z.array(z.unknown()).max(100_000),
            }),
        )
        .max(SESSION_HISTORY_MESSAGE_LIMIT),
    nextCursor: z.string().nullish(),
});
const itemTypeSchema = z.object({ type: z.string().min(1).max(80) });
const userMessageSchema = z.object({
    content: z.array(z.unknown()).max(10_000),
});
const textSchema = z.object({ text: z.string() });
const imageSchema = z.object({ url: z.string() });
const agentMessageSchema = textSchema.extend({ phase: z.string().nullish() });
const reasoningSchema = z.object({
    id: z.string(),
    summary: z.array(z.string()).max(10_000),
    content: z.array(z.string()).max(10_000),
});
const commandExecutionSchema = z.object({
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: z.string(),
    commandActions: z.array(z.object({ type: z.string() }).passthrough()).max(100),
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().int().nullish(),
});

interface ReadCodexHistoryOptions {
    readonly detail: "messages" | "rich";
}

interface CodexHistorySnapshot {
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly history: NativeSessionHistory;
}

function bounded(value: string, maximum: number): string {
    return value.slice(0, maximum);
}

function activity(
    activityId: string,
    activityType: string,
    sequence: number,
    fields: Pick<NativeMessageActivity, "input" | "locations" | "name" | "output" | "status" | "title" | "toolKind">,
): NativeMessageActivity {
    return {
        activityId: bounded(activityId, 128) || `history-${sequence.toString()}`,
        activityType,
        content: [],
        input: bounded(fields.input, 100_000),
        locations: fields.locations
            .filter((location) => location.length > 0)
            .map((location) => bounded(location, 2_048))
            .slice(0, 100),
        name: bounded(fields.name, 128),
        output: bounded(fields.output, 100_000),
        sequence,
        status: bounded(fields.status, 64),
        title: bounded(fields.title, 500),
        toolKind: bounded(fields.toolKind, 64),
    };
}

function errorMessage(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "object" && value !== null) {
        const message = Reflect.get(value, "message");
        if (typeof message === "string") {
            return message;
        }
    }
    return JSON.stringify(value) ?? "Codex stopped before completing this turn.";
}

function messageSize(message: NativeHistoryMessage): number {
    return (
        message.text.length +
        (message.role === "assistant"
            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
            : 0)
    );
}

function decodeHistory(
    thread: z.infer<typeof threadSchema>["thread"],
    value: unknown,
    options: ReadCodexHistoryOptions,
): CodexHistorySnapshot {
    const page = turnsSchema.parse(value);
    const messages: NativeHistoryMessage[] = [];
    let characters = 0;
    let truncated = page.nextCursor != null;
    for (const turn of page.data.toReversed()) {
        const activities: NativeMessageActivity[] = [];
        let sequence = 0;
        let assistantMessageIndex: number | null = null;
        for (const item of turn.items) {
            const { type } = itemTypeSchema.parse(item);
            let message: NativeHistoryMessage;
            if (type === "userMessage") {
                const { content } = userMessageSchema.parse(item);
                const text = content
                    .map((block) => {
                        const { type } = itemTypeSchema.parse(block);
                        if (type === "text") {
                            return textSchema.parse(block).text;
                        }
                        if (type === "image") {
                            return `[@image](${imageSchema.parse(block).url})`;
                        }
                        return "[Attachment]";
                    })
                    .join("");
                message = {
                    role: "user",
                    text,
                };
            } else if (type === "agentMessage") {
                const agent = agentMessageSchema.parse(item);
                if (agent.phase === "commentary") {
                    if (options.detail === "rich" && agent.text.length > 0) {
                        activities.push(
                            activity(`progress-${sequence.toString()}`, "progress", sequence, {
                                input: "",
                                locations: [],
                                name: "",
                                output: agent.text,
                                status: "completed",
                                title: "Progress",
                                toolKind: "",
                            }),
                        );
                        sequence += 1;
                    }
                    continue;
                }
                message = { activities: activities.slice(-100), content: [], role: "assistant", text: agent.text };
            } else if (type === "reasoning" && options.detail === "rich") {
                const reasoning = reasoningSchema.parse(item);
                const output = (reasoning.summary.length > 0 ? reasoning.summary : reasoning.content).join("\n\n");
                if (output.length > 0) {
                    activities.push(
                        activity(reasoning.id, "reasoning", sequence, {
                            input: "",
                            locations: [],
                            name: "",
                            output,
                            status: "completed",
                            title: "Reasoning",
                            toolKind: "",
                        }),
                    );
                    sequence += 1;
                }
                continue;
            } else if (type === "commandExecution" && options.detail === "rich") {
                const command = commandExecutionSchema.parse(item);
                const action = command.commandActions[0]?.type ?? "execute";
                activities.push(
                    activity(command.id, "tool", sequence, {
                        input: JSON.stringify({ command: command.command, cwd: command.cwd }),
                        locations: [command.cwd],
                        name: "",
                        output: JSON.stringify({
                            formatted_output: command.aggregatedOutput ?? "",
                            ...(command.exitCode == null ? {} : { exit_code: command.exitCode }),
                        }),
                        status: command.status === "completed" ? "completed" : "failed",
                        title: command.command,
                        toolKind: action,
                    }),
                );
                sequence += 1;
                continue;
            } else {
                continue;
            }
            const text = message.text.slice(-SESSION_HISTORY_CHARACTER_LIMIT);
            if (text.length === 0 && (message.images?.length ?? 0) === 0) {
                continue;
            }
            truncated ||= text.length < message.text.length;
            messages.push({ ...message, text });
            if (message.role === "assistant") {
                assistantMessageIndex = messages.length - 1;
            }
            characters += messageSize({ ...message, text });
        }
        if (options.detail === "rich" && turn.error != null) {
            activities.push(
                activity(`agent-error-${sequence.toString()}`, "tool", sequence, {
                    input: "",
                    locations: [],
                    name: "",
                    output: errorMessage(turn.error),
                    status: "failed",
                    title: "Agent error",
                    toolKind: "other",
                }),
            );
        }
        if (assistantMessageIndex !== null) {
            const assistant = messages[assistantMessageIndex];
            if (assistant?.role === "assistant") {
                characters -= messageSize(assistant);
                const updated = { ...assistant, activities: activities.slice(-100) };
                messages[assistantMessageIndex] = updated;
                characters += messageSize(updated);
            }
        } else if (activities.length > 0) {
            const message: NativeHistoryMessage = {
                activities: activities.slice(-100),
                content: [],
                role: "assistant",
                text: "",
            };
            messages.push(message);
            characters += messageSize(message);
        }
        while (
            messages.length >
                (options.detail === "rich" ? SESSION_HISTORY_MESSAGE_LIMIT : SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT) ||
            characters > SESSION_HISTORY_CHARACTER_LIMIT
        ) {
            const removed = messages.shift();
            if (removed !== undefined) {
                characters -= messageSize(removed);
            }
            truncated = true;
        }
    }
    return {
        nativeSessionId: thread.id,
        cwd: thread.cwd,
        history: {
            status: "available",
            messages,
            truncated,
            coveredCommandIds: [],
            coveredMessageIds: [],
        },
    };
}

/** Metadata and paginated display history do not acquire the source writer. */
async function readCodexHistoryWithOptions(
    agent: AcpAgentDefinition,
    cwd: string,
    nativeSessionId: string,
    signal: AbortSignal,
    options: ReadCodexHistoryOptions,
): Promise<CodexHistorySnapshot> {
    signal.throwIfAborted();
    nativeSessionIdSchema.parse(nativeSessionId);
    if (agent.id !== "codex" || !(await revalidateExecutable(agent.agentIdentity))) {
        throw new AcpExecutionError(
            "The local Codex executable changed. Restart Mobius to discover it again.",
            {},
            "agent_executable_changed",
        );
    }
    signal.throwIfAborted();
    const child = spawn(agent.agentIdentity.realPath, ["app-server"], {
        cwd,
        env: { ...process.env, ...agent.environment },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
    });
    const response = Promise.withResolvers<CodexHistorySnapshot>();
    type ReadState =
        | { readonly kind: "initializing"; readonly requestId: 1 }
        | { readonly kind: "metadata"; readonly requestId: 2 }
        | {
              readonly kind: "turns";
              readonly requestId: number;
              readonly thread: z.infer<typeof threadSchema>["thread"];
              readonly pages: z.infer<typeof turnsSchema>["data"];
          };
    let state: ReadState = { kind: "initializing", requestId: 1 };
    const seenCursors = new Set<string>();
    let pending = "";
    let receivedBytes = 0;
    const fail = (cause: unknown): void =>
        response.reject(
            cause instanceof AcpExecutionError
                ? cause
                : new AcpExecutionError(
                      "Saved Codex history could not be read.",
                      { cause },
                      "native_history_unavailable",
                  ),
        );
    const send = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const onData = (chunk: string): void => {
        try {
            receivedBytes += Buffer.byteLength(chunk);
            if (receivedBytes > 32 * 1_024 * 1_024) {
                throw new AcpExecutionError(
                    "This saved conversation is too large to preview.",
                    {},
                    "native_history_too_large",
                );
            }
            pending += chunk;
            let newline = pending.indexOf("\n");
            while (newline >= 0) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf("\n");
                if (line.trim().length === 0) {
                    continue;
                }
                const value: unknown = JSON.parse(line);
                const message = responseSchema.parse(value);
                if (!("id" in message)) {
                    continue;
                }
                if (message.id !== state.requestId) {
                    throw new AcpExecutionError(
                        "Codex returned an invalid history response.",
                        {},
                        "invalid_native_session_response",
                    );
                }
                if ("error" in message) {
                    fail(
                        new AcpExecutionError(
                            "Saved Codex history could not be read.",
                            { cause: message.error },
                            "native_history_unavailable",
                        ),
                    );
                    return;
                }
                switch (state.kind) {
                    case "initializing":
                        state = { kind: "metadata", requestId: 2 };
                        send({ method: "initialized", params: {} });
                        send({
                            id: state.requestId,
                            method: "thread/read",
                            params: { threadId: nativeSessionId, includeTurns: false },
                        });
                        break;
                    case "metadata": {
                        const { thread } = threadSchema.parse(message.result);
                        state = { kind: "turns", requestId: 3, thread, pages: [] };
                        send({
                            id: state.requestId,
                            method: "thread/turns/list",
                            params: {
                                threadId: nativeSessionId,
                                limit: SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
                                sortDirection: "desc",
                                itemsView: options.detail === "rich" ? "full" : "summary",
                            },
                        });
                        break;
                    }
                    case "turns": {
                        const page = turnsSchema.parse(message.result);
                        const pages = [...state.pages, ...page.data];
                        const maxTurns =
                            options.detail === "rich"
                                ? SESSION_HISTORY_MESSAGE_LIMIT
                                : SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT;
                        if (page.nextCursor == null || pages.length >= maxTurns) {
                            response.resolve(
                                decodeHistory(
                                    state.thread,
                                    {
                                        data: pages.slice(0, maxTurns),
                                        nextCursor: page.nextCursor,
                                    },
                                    options,
                                ),
                            );
                            return;
                        }
                        if (page.data.length === 0 || seenCursors.has(page.nextCursor)) {
                            throw new AcpExecutionError(
                                "Codex repeated a history page cursor.",
                                {},
                                "invalid_native_session_response",
                            );
                        }
                        seenCursors.add(page.nextCursor);
                        state = { kind: "turns", requestId: state.requestId + 1, thread: state.thread, pages };
                        send({
                            id: state.requestId,
                            method: "thread/turns/list",
                            params: {
                                threadId: nativeSessionId,
                                cursor: page.nextCursor,
                                limit: Math.min(SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT, maxTurns - pages.length),
                                sortDirection: "desc",
                                itemsView: options.detail === "rich" ? "full" : "summary",
                            },
                        });
                        break;
                    }
                    default: {
                        const unhandled: never = state;
                        throw new Error(`Unknown history read state: ${String(unhandled)}`);
                    }
                }
            }
        } catch (cause) {
            fail(cause);
        }
    };
    const abort = (): void => response.reject(signal.reason);
    const onExit = (): void =>
        fail(
            new AcpExecutionError(
                "Codex stopped before its saved history was available.",
                {},
                "native_history_unavailable",
            ),
        );
    const timeout = setTimeout(
        () => fail(new AcpExecutionError("Reading saved Codex history timed out.", {}, "native_history_timeout")),
        options.detail === "rich" ? 60_000 : 15_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", onExit);
    signal.addEventListener("abort", abort, { once: true });
    try {
        if (signal.aborted) {
            abort();
        } else {
            send({
                id: 1,
                method: "initialize",
                params: { clientInfo: { name: "mobius_history", version: "1.0.0" } },
            });
        }
        const snapshot = await response.promise;
        return {
            ...snapshot,
            history: await embedLocalHistoryImages(snapshot.history, signal),
        };
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        child.stdout.removeListener("data", onData);
        if (child.pid !== undefined) {
            await stopProcessTree(child);
        }
        child.stdin.removeListener("error", fail);
        child.removeListener("error", fail);
        child.removeListener("exit", onExit);
    }
}

/** Reads the compact message transcript used by native-session previews. */
export const readCodexHistory = async (
    agent: AcpAgentDefinition,
    cwd: string,
    nativeSessionId: string,
    signal: AbortSignal,
): Promise<CodexHistorySnapshot> =>
    await readCodexHistoryWithOptions(agent, cwd, nativeSessionId, signal, { detail: "messages" });

/** Reads the complete Codex turn items used to restore non-retained Chats. */
export const readCodexFullHistory = async (
    agent: AcpAgentDefinition,
    cwd: string,
    nativeSessionId: string,
    signal: AbortSignal,
): Promise<CodexHistorySnapshot> =>
    await readCodexHistoryWithOptions(agent, cwd, nativeSessionId, signal, { detail: "rich" });
