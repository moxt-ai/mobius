import { spawn } from "node:child_process";
import {
    type AgentDisplayContent,
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
                id: z.string().min(1),
                status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
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
    type: z.literal("userMessage"),
});
const textSchema = z.object({ text: z.string() });
const imageSchema = z.object({ url: z.string() });
const agentMessageSchema = textSchema.extend({
    id: z.string().optional(),
    phase: z.string().nullish(),
    type: z.literal("agentMessage"),
});
const reasoningSchema = z.object({
    id: z.string(),
    summary: z.array(z.string()).max(10_000),
    content: z.array(z.string()).max(10_000),
    type: z.literal("reasoning"),
});
const commandExecutionSchema = z.object({
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: z.string(),
    commandActions: z.array(z.object({ type: z.string() }).passthrough()).max(100),
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().int().nullish(),
    type: z.literal("commandExecution"),
});
const fileChangeSchema = z.object({
    changes: z.array(z.object({ diff: z.string(), path: z.string() })).max(10_000),
    id: z.string(),
    status: z.string(),
    type: z.literal("fileChange"),
});
const mcpToolCallSchema = z.object({
    arguments: z.unknown().optional(),
    error: z.unknown().nullish(),
    id: z.string(),
    result: z.unknown().nullish(),
    server: z.string(),
    status: z.string(),
    tool: z.string(),
    type: z.literal("mcpToolCall"),
});
const dynamicToolCallSchema = z.object({
    arguments: z.unknown().optional(),
    contentItems: z.array(z.unknown()).max(10_000).nullish(),
    id: z.string(),
    namespace: z.string().nullish(),
    status: z.string(),
    tool: z.string(),
    type: z.literal("dynamicToolCall"),
});
const planSchema = z.object({ id: z.string(), text: z.string(), type: z.literal("plan") });
const historyItemSchema = z.discriminatedUnion("type", [
    userMessageSchema,
    agentMessageSchema,
    reasoningSchema,
    commandExecutionSchema,
    fileChangeSchema,
    mcpToolCallSchema,
    dynamicToolCallSchema,
    planSchema,
]);

interface ReadCodexHistoryOptions {
    readonly detail: "messages" | "rich";
    readonly nativeTurn?: () => { readonly commandId: string; readonly nativeTurnId: string } | null;
}

interface CodexHistorySnapshot {
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly history: NativeSessionHistory;
}

class CodexHistoryResponseError extends Error {
    readonly code: number;

    constructor(response: { readonly code: number; readonly message: string }) {
        super(response.message);
        this.code = response.code;
        this.name = "CodexHistoryResponseError";
    }
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

function formatted(value: unknown): string {
    if (value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value) ?? "";
}

function toolStatus(status: string): string {
    return status === "inProgress" ? "running" : status === "completed" ? "completed" : "failed";
}

function diffDisplayContent(path: string, newText: string): AgentDisplayContent {
    return {
        artifactId: "",
        data: "",
        mimeType: "",
        name: "",
        newText,
        oldText: "",
        path,
        terminalId: "",
        text: "",
        type: "diff",
        uri: "",
    };
}

function messageSize(message: NativeHistoryMessage): number {
    return (
        message.text.length +
        (message.role === "assistant"
            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
            : 0)
    );
}

const SESSION_HISTORY_MESSAGE_CHARACTER_LIMIT = Math.floor(SESSION_HISTORY_CHARACTER_LIMIT / 2);

function fitActivity(activity: NativeMessageActivity, maximumCharacters: number): NativeMessageActivity {
    const truncate = (limit: number): NativeMessageActivity => ({
        ...activity,
        input: bounded(activity.input, limit),
        locations: activity.locations.map((location) => bounded(location, Math.max(1, limit))),
        name: bounded(activity.name, limit),
        output: bounded(activity.output, limit),
        title: bounded(activity.title, limit),
        toolKind: bounded(activity.toolKind, limit),
    });
    let minimum = 1;
    let maximum = 100_000;
    let fitted = truncate(0);
    while (minimum <= maximum) {
        const limit = Math.floor((minimum + maximum) / 2);
        const candidate = truncate(limit);
        if (JSON.stringify(candidate).length <= maximumCharacters) {
            fitted = candidate;
            minimum = limit + 1;
        } else {
            maximum = limit - 1;
        }
    }
    return fitted;
}

function fitActivities(
    activities: readonly NativeMessageActivity[],
    maximumCharacters: number,
): readonly NativeMessageActivity[] {
    if (activities.length === 0) {
        return activities;
    }
    const arrayCharacters = 2 + activities.length - 1;
    const maximumActivityCharacters = Math.floor(Math.max(0, maximumCharacters - arrayCharacters) / activities.length);
    return activities.map((activity) => fitActivity(activity, maximumActivityCharacters));
}

function fitHistoryMessage(
    message: NativeHistoryMessage,
    maximumCharacters = SESSION_HISTORY_MESSAGE_CHARACTER_LIMIT,
): {
    readonly message: NativeHistoryMessage;
    readonly truncated: boolean;
} {
    const text = message.text.slice(-maximumCharacters);
    if (message.role === "user") {
        return {
            message: { ...message, text },
            truncated: text.length < message.text.length,
        };
    }

    let activities = message.activities;
    const content = message.content;
    let fitted: NativeHistoryMessage = { ...message, activities, content, text };
    if (messageSize(fitted) > maximumCharacters && activities.length > 0) {
        const maximumActivityCharacters = maximumCharacters - text.length - JSON.stringify(content).length;
        activities = fitActivities(activities, maximumActivityCharacters);
        fitted = { ...fitted, activities };
    }
    const excess = Math.max(0, messageSize(fitted) - maximumCharacters);
    if (excess > 0) {
        const maximumTextLength = Math.max(0, fitted.text.length - excess);
        fitted = {
            ...fitted,
            text: maximumTextLength === 0 ? "" : fitted.text.slice(-maximumTextLength),
        };
    }
    return {
        message: fitted,
        truncated:
            fitted.text.length < message.text.length ||
            JSON.stringify(activities).length < JSON.stringify(message.activities).length,
    };
}

function turnOutcome(
    status: z.infer<typeof turnsSchema>["data"][number]["status"],
): Extract<NativeHistoryMessage, { readonly role: "assistant" }>["outcome"] {
    switch (status) {
        case "completed":
            return "succeeded";
        case "interrupted":
            return "cancelled";
        case "failed":
            return "failed";
        case "inProgress":
            return undefined;
        default: {
            const unhandled: never = status;
            throw new Error(`Unknown Codex turn status: ${String(unhandled)}`);
        }
    }
}

function decodeHistory(
    thread: z.infer<typeof threadSchema>["thread"],
    value: unknown,
    options: ReadCodexHistoryOptions,
): CodexHistorySnapshot {
    const page = turnsSchema.parse(value);
    const nativeTurn = options.nativeTurn?.();
    const coveredCommandIds =
        nativeTurn != null && page.data[0]?.id === nativeTurn.nativeTurnId ? [nativeTurn.commandId] : [];
    const messages: NativeHistoryMessage[] = [];
    let characters = 0;
    let truncated = page.nextCursor != null;
    for (const turn of page.data.toReversed()) {
        const outcome = turnOutcome(turn.status);
        const turnMessageCharacterLimit = Math.max(
            1,
            Math.floor(SESSION_HISTORY_CHARACTER_LIMIT / Math.max(1, turn.items.length + (turn.error == null ? 0 : 1))),
        );
        let sequence = 0;
        let assistantMessageIndex: number | null = null;
        const append = (message: NativeHistoryMessage): void => {
            const fitted = fitHistoryMessage(message, turnMessageCharacterLimit);
            if (
                fitted.message.text.length === 0 &&
                (fitted.message.images?.length ?? 0) === 0 &&
                (fitted.message.role === "user" ||
                    (fitted.message.activities.length === 0 && fitted.message.content.length === 0))
            ) {
                return;
            }
            truncated ||= fitted.truncated;
            messages.push(fitted.message);
            if (fitted.message.role === "assistant") {
                assistantMessageIndex = messages.length - 1;
            }
            characters += messageSize(fitted.message);
        };
        for (const item of turn.items) {
            const decoded = historyItemSchema.safeParse(item);
            if (!decoded.success) {
                continue;
            }
            const historyItem = decoded.data;
            if (historyItem.type === "userMessage") {
                const text = historyItem.content
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
                append({
                    role: "user",
                    text,
                });
            } else if (historyItem.type === "agentMessage") {
                if (historyItem.phase === "commentary") {
                    if (options.detail === "rich" && historyItem.text.length > 0) {
                        append({
                            activities: [
                                activity(historyItem.id ?? `reasoning-${sequence.toString()}`, "reasoning", sequence, {
                                    input: "",
                                    locations: [],
                                    name: "",
                                    output: historyItem.text,
                                    status: "completed",
                                    title: "Reasoning",
                                    toolKind: "think",
                                }),
                            ],
                            content: [],
                            role: "assistant",
                            text: "",
                        });
                        sequence += 1;
                    }
                    continue;
                }
                append({ activities: [], content: [], role: "assistant", text: historyItem.text });
            } else if (historyItem.type === "reasoning" && options.detail === "rich") {
                const output = (historyItem.summary.length > 0 ? historyItem.summary : historyItem.content).join(
                    "\n\n",
                );
                if (output.length > 0) {
                    append({
                        activities: [
                            activity(historyItem.id, "reasoning", sequence, {
                                input: "",
                                locations: [],
                                name: "",
                                output,
                                status: "completed",
                                title: "Reasoning",
                                toolKind: "",
                            }),
                        ],
                        content: [],
                        role: "assistant",
                        text: "",
                    });
                    sequence += 1;
                }
            } else if (historyItem.type === "commandExecution" && options.detail === "rich") {
                const action = historyItem.commandActions[0]?.type ?? "execute";
                append({
                    activities: [
                        activity(historyItem.id, "tool", sequence, {
                            input: JSON.stringify({ command: historyItem.command, cwd: historyItem.cwd }),
                            locations: [historyItem.cwd],
                            name: "",
                            output: JSON.stringify({
                                formatted_output: historyItem.aggregatedOutput ?? "",
                                ...(historyItem.exitCode == null ? {} : { exit_code: historyItem.exitCode }),
                            }),
                            status: toolStatus(historyItem.status),
                            title: historyItem.command,
                            toolKind: action,
                        }),
                    ],
                    content: [],
                    role: "assistant",
                    text: "",
                });
                sequence += 1;
            } else if (historyItem.type === "fileChange" && options.detail === "rich") {
                const paths = historyItem.changes.map((change) => change.path);
                const content = historyItem.changes.map(
                    (change): AgentDisplayContent => diffDisplayContent(change.path, change.diff),
                );
                append({
                    activities: [
                        activity(historyItem.id, "tool", sequence, {
                            input: JSON.stringify({ changes: paths }),
                            locations: paths,
                            name: "",
                            output: "",
                            status: toolStatus(historyItem.status),
                            title: paths.join(", "),
                            toolKind: "edit",
                        }),
                    ].map((entry) => ({ ...entry, content })),
                    content: [],
                    role: "assistant",
                    text: "",
                });
                sequence += 1;
            } else if (historyItem.type === "mcpToolCall" && options.detail === "rich") {
                append({
                    activities: [
                        activity(historyItem.id, "tool", sequence, {
                            input: formatted(historyItem.arguments),
                            locations: [],
                            name: historyItem.tool,
                            output: formatted(historyItem.error ?? historyItem.result),
                            status: toolStatus(historyItem.status),
                            title: `${historyItem.server}/${historyItem.tool}`,
                            toolKind: "other",
                        }),
                    ],
                    content: [],
                    role: "assistant",
                    text: "",
                });
                sequence += 1;
            } else if (historyItem.type === "dynamicToolCall" && options.detail === "rich") {
                append({
                    activities: [
                        activity(historyItem.id, "tool", sequence, {
                            input: formatted(historyItem.arguments),
                            locations: [],
                            name: historyItem.tool,
                            output: formatted(historyItem.contentItems),
                            status: toolStatus(historyItem.status),
                            title:
                                historyItem.namespace == null
                                    ? historyItem.tool
                                    : `${historyItem.namespace}/${historyItem.tool}`,
                            toolKind: "other",
                        }),
                    ],
                    content: [],
                    role: "assistant",
                    text: "",
                });
                sequence += 1;
            } else if (historyItem.type === "plan" && options.detail === "rich") {
                append({
                    activities: [
                        activity(historyItem.id, "plan", sequence, {
                            input: "",
                            locations: [],
                            name: "",
                            output: historyItem.text,
                            status: "completed",
                            title: "Plan",
                            toolKind: "",
                        }),
                    ],
                    content: [],
                    role: "assistant",
                    text: "",
                });
                sequence += 1;
            }
        }
        if (options.detail === "rich" && turn.error != null) {
            append({
                activities: [
                    activity(`agent-error-${sequence.toString()}`, "tool", sequence, {
                        input: "",
                        locations: [],
                        name: "",
                        output: errorMessage(turn.error),
                        status: "failed",
                        title: "Agent error",
                        toolKind: "other",
                    }),
                ],
                content: [],
                role: "assistant",
                text: "",
            });
        }
        if (assistantMessageIndex !== null) {
            const assistant = messages[assistantMessageIndex];
            if (assistant?.role === "assistant") {
                characters -= messageSize(assistant);
                const updated: NativeHistoryMessage = {
                    ...assistant,
                    ...(outcome === undefined ? {} : { outcome }),
                };
                const fitted = fitHistoryMessage(updated, turnMessageCharacterLimit);
                truncated ||= fitted.truncated;
                messages[assistantMessageIndex] = fitted.message;
                characters += messageSize(fitted.message);
            }
        } else if (outcome !== undefined) {
            const message: NativeHistoryMessage = {
                activities: [],
                content: [],
                role: "assistant",
                ...(outcome === undefined ? {} : { outcome }),
                text: "",
            };
            const fitted = fitHistoryMessage(message, turnMessageCharacterLimit);
            truncated ||= fitted.truncated;
            messages.push(fitted.message);
            characters += messageSize(fitted.message);
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
            coveredCommandIds,
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
    let pendingBytes = 0;
    let pendingFragments: string[] = [];
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
            let cursor = 0;
            let newline = chunk.indexOf("\n");
            while (newline >= 0) {
                const fragment = chunk.slice(cursor, newline);
                const lineBytes = pendingBytes + Buffer.byteLength(fragment);
                if (lineBytes > 32 * 1_024 * 1_024) {
                    throw new AcpExecutionError(
                        "This saved conversation is too large to preview.",
                        {},
                        "native_history_too_large",
                    );
                }
                const line = pendingFragments.length === 0 ? fragment : [...pendingFragments, fragment].join("");
                pendingBytes = 0;
                pendingFragments = [];
                cursor = newline + 1;
                newline = chunk.indexOf("\n", cursor);
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
                            { cause: new CodexHistoryResponseError(message.error) },
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
            const remainder = chunk.slice(cursor);
            if (remainder.length > 0) {
                pendingBytes += Buffer.byteLength(remainder);
                if (pendingBytes > 32 * 1_024 * 1_024) {
                    throw new AcpExecutionError(
                        "This saved conversation is too large to preview.",
                        {},
                        "native_history_too_large",
                    );
                }
                pendingFragments.push(remainder);
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
    nativeTurn?: ReadCodexHistoryOptions["nativeTurn"],
): Promise<CodexHistorySnapshot> =>
    await readCodexHistoryWithOptions(agent, cwd, nativeSessionId, signal, {
        detail: "rich",
        ...(nativeTurn === undefined ? {} : { nativeTurn }),
    });
