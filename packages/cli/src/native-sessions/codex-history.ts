import { spawn } from "node:child_process";
import {
    type NativeHistoryMessage,
    type NativeSessionHistory,
    parseNativeHistoryText,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_IMAGE_CHARACTER_LIMIT,
    SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { nativeSessionIdSchema } from "../acp/native-session.ts";
import { AcpExecutionError } from "../acp/session-manager.ts";
import type { LocalAgentDefinition } from "../agent-catalog/local-agent.ts";
import { revalidateExecutable, stopProcessTree } from "../process/executable.ts";

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
    data: z.array(z.object({ items: z.array(z.unknown()).max(100_000) })).max(SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT),
    nextCursor: z.string().nullish(),
});
const itemTypeSchema = z.object({ type: z.string().min(1).max(80) });
const userMessageSchema = z.object({
    content: z.array(z.unknown()).max(10_000),
});
const textSchema = z.object({ text: z.string() });
const imageSchema = z.object({ url: z.string() });
const agentMessageSchema = textSchema.extend({ phase: z.string().nullish() });

interface CodexHistorySnapshot {
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly history: NativeSessionHistory;
}

function decodeHistory(thread: z.infer<typeof threadSchema>["thread"], value: unknown): CodexHistorySnapshot {
    const page = turnsSchema.parse(value);
    const messages: NativeHistoryMessage[] = [];
    let characters = 0;
    let imageCharacters = 0;
    let truncated = page.nextCursor != null;
    for (const turn of page.data.toReversed()) {
        for (const item of turn.items) {
            const { type } = itemTypeSchema.parse(item);
            let message: NativeHistoryMessage;
            if (type === "userMessage") {
                const { content } = userMessageSchema.parse(item);
                const parsed = parseNativeHistoryText(
                    content
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
                        .join(""),
                );
                message = {
                    role: "user",
                    text: parsed.text,
                    ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
                };
            } else if (type === "agentMessage") {
                const agent = agentMessageSchema.parse(item);
                if (agent.phase === "commentary") {
                    continue;
                }
                message = { role: "assistant", text: agent.text };
            } else {
                continue;
            }
            const text = message.text.slice(-SESSION_HISTORY_CHARACTER_LIMIT);
            if (text.length === 0 && (message.images?.length ?? 0) === 0) {
                continue;
            }
            truncated ||= text.length < message.text.length;
            messages.push({ ...message, text });
            characters += text.length;
            imageCharacters += (message.images ?? []).reduce((size, image) => size + image.data.length, 0);
            while (
                messages.length > SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT ||
                characters > SESSION_HISTORY_CHARACTER_LIMIT ||
                imageCharacters > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT
            ) {
                const removed = messages.shift();
                if (removed !== undefined) {
                    characters -= removed.text.length;
                    imageCharacters -= (removed.images ?? []).reduce((size, image) => size + image.data.length, 0);
                }
                truncated = true;
            }
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
export async function readCodexHistory(
    agent: LocalAgentDefinition,
    cwd: string,
    nativeSessionId: string,
    signal: AbortSignal,
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
              readonly requestId: 3;
              readonly thread: z.infer<typeof threadSchema>["thread"];
          };
    let state: ReadState = { kind: "initializing", requestId: 1 };
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
                        state = { kind: "turns", requestId: 3, thread };
                        send({
                            id: state.requestId,
                            method: "thread/turns/list",
                            params: {
                                threadId: nativeSessionId,
                                limit: SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
                                sortDirection: "desc",
                                itemsView: "summary",
                            },
                        });
                        break;
                    }
                    case "turns":
                        response.resolve(decodeHistory(state.thread, message.result));
                        return;
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
        15_000,
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
        return await response.promise;
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
