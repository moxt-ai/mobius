import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
    getSessionMessages,
    type SessionKey,
    type SessionStore,
    type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionHistoryMessageV3 } from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { NativeSessionOperationErrorV3, type NativeSessionPreviewAdapterV3 } from "../adapter-v3.ts";

const textBlockSchema = z.object({ text: z.string().max(1_000_000), type: z.literal("text") });
const thinkingBlockSchema = z.object({ thinking: z.string().max(1_000_000), type: z.literal("thinking") });
const toolUseBlockSchema = z.object({
    id: z.string().min(1).max(2_048),
    name: z.string().max(2_048),
    type: z.literal("tool_use"),
});
const nativeMessageSchema = z.object({
    content: z.union([z.string().max(1_000_000), z.array(z.unknown()).max(1_000)]),
    role: z.enum(["assistant", "user"]),
});
const sessionMessageSchema = z.object({
    message: nativeMessageSchema,
    session_id: z.string().min(1).max(2_048),
    type: z.enum(["assistant", "user"]),
    uuid: z.string().min(1).max(2_048),
});
const sessionStoreEntrySchema = z.object({ type: z.string().min(1).max(128) }).passthrough();
const MAX_TRANSCRIPT_BYTES = 512 * 1_024 * 1_024;
const CURSOR_PREFIX = "mobius-claude-v3:";
const cursorSchema = z
    .strictObject({
        afterUuid: z.string().min(1).max(2_048),
        offset: z.number().int().positive().safe(),
    })
    .readonly();
type ClaudeCursor = z.infer<typeof cursorSchema>;

function decodeCursor(cursor: string | null): ClaudeCursor | null {
    if (cursor === null) {
        return null;
    }
    if (!cursor.startsWith(CURSOR_PREFIX)) {
        throw new NativeSessionOperationErrorV3("invalid_history_cursor", "The Claude Code history cursor is invalid");
    }
    try {
        const value: unknown = JSON.parse(
            Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
        );
        return cursorSchema.parse(value);
    } catch (cause) {
        throw new NativeSessionOperationErrorV3("invalid_history_cursor", "The Claude Code history cursor is invalid", {
            cause,
        });
    }
}

function encodeCursor(cursor: ClaudeCursor): string {
    return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function isMissingFile(error: unknown): boolean {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

class ClaudeTranscriptSessionStoreV3 implements SessionStore {
    readonly #configDirectory: string;

    constructor(configDirectory: string) {
        this.#configDirectory = resolve(configDirectory);
    }

    readonly append = async (): Promise<void> => {
        throw new NativeSessionOperationErrorV3(
            "native_session_read_only",
            "The Claude transcript reader is read-only",
        );
    };

    readonly load = async (key: SessionKey): Promise<SessionStoreEntry[] | null> => {
        if (key.subpath !== undefined || !/^[^/\\]{1,255}$/u.test(key.projectKey)) {
            throw new NativeSessionOperationErrorV3(
                "invalid_native_session_response",
                "Claude Code selected an invalid transcript key",
            );
        }
        const projectsDirectory = resolve(this.#configDirectory, "projects");
        const path = resolve(projectsDirectory, key.projectKey, `${key.sessionId}.jsonl`);
        const resolvedRelative = relative(projectsDirectory, path);
        if (resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) {
            throw new NativeSessionOperationErrorV3(
                "invalid_native_session_response",
                "Claude Code selected a transcript outside its configuration directory",
            );
        }
        try {
            if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) {
                throw new NativeSessionOperationErrorV3(
                    "native_history_page_too_large",
                    "The Claude Code transcript exceeds the history bound",
                );
            }
            const encoded = await readFile(path, "utf8");
            const entries: SessionStoreEntry[] = [];
            for (const line of encoded.split("\n")) {
                if (line.trim().length === 0) {
                    continue;
                }
                const value: unknown = JSON.parse(line);
                entries.push(sessionStoreEntrySchema.parse(value));
            }
            return entries;
        } catch (error) {
            if (isMissingFile(error)) {
                return null;
            }
            throw error;
        }
    };
}

function textContent(
    content: string | readonly unknown[],
    role: "assistant" | "user",
): readonly { readonly text: string; readonly type: "text" }[] {
    if (typeof content === "string") {
        return content.length === 0 ? [] : [{ text: content, type: "text" }];
    }
    const text = content
        .flatMap((block) => {
            const decoded = textBlockSchema.safeParse(block);
            if (decoded.success) {
                return [decoded.data.text];
            }
            if (role === "assistant") {
                const thinking = thinkingBlockSchema.safeParse(block);
                if (thinking.success) {
                    return [thinking.data.thinking];
                }
            }
            return [];
        })
        .join("");
    return text.length === 0 ? [] : [{ text, type: "text" }];
}

function projectMessage(sessionId: string, value: unknown): SessionHistoryMessageV3 | null {
    const decoded = sessionMessageSchema.safeParse(value);
    if (!decoded.success || decoded.data.session_id !== sessionId) {
        return null;
    }
    const { message, uuid } = decoded.data;
    if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
            const tool = toolUseBlockSchema.safeParse(block);
            if (tool.success) {
                return {
                    item: {
                        name: tool.data.name,
                        status: "completed",
                        title: tool.data.name,
                        toolCallId: tool.data.id,
                        sessionUpdate: "tool_call",
                    },
                    messageId: uuid,
                    sessionId,
                };
            }
        }
    }
    return {
        item: {
            content: textContent(message.content, message.role),
            sessionUpdate: message.role === "assistant" ? "agent_message" : "user_message",
        },
        messageId: uuid,
        sessionId,
    };
}

export class ClaudeNativeSessionPreviewAdapterV3 implements NativeSessionPreviewAdapterV3 {
    readonly #sessionStore: SessionStore | undefined;

    constructor(configDirectory?: string) {
        this.#sessionStore =
            configDirectory === undefined ? undefined : new ClaudeTranscriptSessionStoreV3(configDirectory);
    }

    readonly previewMessages: NativeSessionPreviewAdapterV3["previewMessages"] = async (session, request, signal) => {
        signal.throwIfAborted();
        const cursor = decodeCursor(request.cursor);
        const nativeMessages: unknown = await getSessionMessages(session.nativeSessionId, {
            dir: session.cwd,
            limit: request.messageLimit + (cursor === null ? 1 : 2),
            offset: cursor === null ? 0 : cursor.offset - 1,
            ...(this.#sessionStore === undefined ? {} : { sessionStore: this.#sessionStore }),
        });
        signal.throwIfAborted();
        if (!Array.isArray(nativeMessages)) {
            throw new NativeSessionOperationErrorV3(
                "invalid_native_session_response",
                "Claude Code returned invalid Session history",
            );
        }
        const messages = nativeMessages.map((message) => {
            const projected = projectMessage(session.nativeSessionId, message);
            if (projected === null) {
                throw new NativeSessionOperationErrorV3(
                    "invalid_native_session_response",
                    "Claude Code returned invalid Session history",
                );
            }
            return { ...projected, sessionId: request.sessionId };
        });
        if (cursor !== null && messages[0]?.messageId !== cursor.afterUuid) {
            throw new NativeSessionOperationErrorV3(
                "invalid_history_cursor",
                "The Claude Code history cursor is invalid",
            );
        }
        const start = cursor === null ? 0 : 1;
        const pageMessages = messages.slice(start, start + request.messageLimit);
        const hasMore = start + pageMessages.length < messages.length;
        const last = pageMessages[pageMessages.length - 1];
        return {
            messages: pageMessages,
            nextCursor:
                hasMore && last !== undefined
                    ? encodeCursor({ afterUuid: last.messageId, offset: (cursor?.offset ?? 0) + pageMessages.length })
                    : null,
            throughSeq: 0,
        };
    };
}
