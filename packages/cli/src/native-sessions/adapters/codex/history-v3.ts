import {
    type SessionHistoryMessageV3,
    type SessionHistoryPageRequestV3,
    sessionHistoryPageV3Schema,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { NativeSessionOperationErrorV3 } from "../adapter-v3.ts";
import type { CodexAppServerClient } from "./app-server-client.ts";
import {
    CODEX_HISTORY_TURN_PAGE_LIMIT,
    type ThreadItem,
    threadItemSchema,
    threadTurnsPageSchema,
} from "./app-server-protocol.ts";

const MAX_PROJECTED_MESSAGES = 1_000;
const BUFFERED_CURSOR_PREFIX = "mobius-codex-v3:";
const bufferedCursorSchema = z
    .strictObject({
        nativeCursor: z.string().min(1).max(1_024).nullable(),
        skip: z.number().int().positive().safe(),
    })
    .readonly();

interface DecodedCursor {
    readonly nativeCursor: string | null;
    readonly skip: number;
}

function decodeCursor(cursor: string | null): DecodedCursor {
    if (cursor === null || !cursor.startsWith(BUFFERED_CURSOR_PREFIX)) {
        return { nativeCursor: cursor, skip: 0 };
    }
    try {
        const encoded = cursor.slice(BUFFERED_CURSOR_PREFIX.length);
        const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        return bufferedCursorSchema.parse(value);
    } catch (cause) {
        throw new NativeSessionOperationErrorV3("invalid_history_cursor", "The Codex history cursor is invalid", {
            cause,
        });
    }
}

function encodeBufferedCursor(nativeCursor: string | null, skip: number): string {
    const encoded = Buffer.from(JSON.stringify({ nativeCursor, skip }), "utf8").toString("base64url");
    return `${BUFFERED_CURSOR_PREFIX}${encoded}`;
}

function decodeThreadItem(value: unknown): ThreadItem | null {
    const decoded = threadItemSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
}

function toolStatus(status: string): "completed" | "failed" | "in_progress" {
    if (status === "completed") {
        return "completed";
    }
    if (status === "failed" || status === "declined" || status === "interrupted") {
        return "failed";
    }
    return "in_progress";
}

function userMessageText(item: Extract<ThreadItem, { readonly type: "userMessage" }>): string {
    return item.content
        .flatMap((content) => {
            if (typeof content !== "object" || content === null) {
                return [];
            }
            const type = Reflect.get(content, "type");
            const text = Reflect.get(content, "text");
            return (type === "text" || type === "inputText") && typeof text === "string" ? [text] : [];
        })
        .join("");
}

export function projectCodexHistoryMessageV3(sessionId: string, item: ThreadItem): SessionHistoryMessageV3 {
    if (item.type === "userMessage") {
        const text = userMessageText(item);
        return {
            item: { content: text.length === 0 ? [] : [{ text, type: "text" }], sessionUpdate: "user_message" },
            messageId: item.id,
            sessionId,
        };
    }
    if (item.type === "agentMessage") {
        return {
            item: {
                content: item.text.length === 0 ? [] : [{ text: item.text, type: "text" }],
                sessionUpdate: "agent_message",
            },
            messageId: item.id,
            sessionId,
        };
    }
    if (item.type === "reasoning") {
        const text = (item.summary.length === 0 ? item.content : item.summary).join("\n");
        return {
            item: {
                content: text.length === 0 ? [] : [{ text, type: "text" }],
                sessionUpdate: "agent_thought",
            },
            messageId: item.id,
            sessionId,
        };
    }
    if (item.type === "plan") {
        return {
            item: {
                entries: [{ content: item.text, priority: "medium", status: "in_progress" }],
                sessionUpdate: "plan",
            },
            messageId: item.id,
            sessionId,
        };
    }
    if (item.type === "commandExecution") {
        return {
            item: {
                content:
                    item.aggregatedOutput == null || item.aggregatedOutput.length === 0
                        ? undefined
                        : [{ content: { text: item.aggregatedOutput, type: "text" }, type: "content" }],
                kind: "execute",
                locations: [{ path: item.cwd }],
                status: toolStatus(item.status),
                title: item.command,
                toolCallId: item.id,
                sessionUpdate: "tool_call",
            },
            messageId: item.id,
            sessionId,
        };
    }
    if (item.type === "fileChange") {
        return {
            item: {
                content: item.changes.map((change) => ({ newText: change.diff, path: change.path, type: "diff" })),
                kind: "edit",
                locations: item.changes.map((change) => ({ path: change.path })),
                status: toolStatus(item.status),
                title: item.changes.length === 1 ? (item.changes[0]?.path ?? "File change") : "File changes",
                toolCallId: item.id,
                sessionUpdate: "tool_call",
            },
            messageId: item.id,
            sessionId,
        };
    }
    const title =
        item.type === "mcpToolCall"
            ? `${item.server}: ${item.tool}`
            : item.type === "dynamicToolCall"
              ? item.tool
              : item.type === "imageView"
                ? item.path
                : item.type === "imageGeneration"
                  ? "Generate image"
                  : item.type === "subAgentActivity"
                    ? `${item.kind}: ${item.agentPath}`
                    : item.tool;
    const status =
        item.type === "imageView" || item.type === "subAgentActivity"
            ? "completed"
            : item.type === "imageGeneration"
              ? toolStatus(item.status)
              : toolStatus(item.status);
    return {
        item: {
            kind: item.type === "imageView" ? "read" : "other",
            status,
            title,
            toolCallId: item.id,
            sessionUpdate: "tool_call",
        },
        messageId: item.id,
        sessionId,
    };
}

/** Translates Codex's native turn pagination without replacing its cursor identity. */
export class CodexHistoryAdapterV3 {
    readonly #appServer: CodexAppServerClient;

    constructor(appServer: CodexAppServerClient) {
        this.#appServer = appServer;
    }

    readonly page = async (
        nativeSessionId: string,
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<{ readonly messages: readonly SessionHistoryMessageV3[]; readonly nextCursor: string | null }> => {
        signal.throwIfAborted();
        const cursor = decodeCursor(request.cursor);
        const page = threadTurnsPageSchema.parse(
            await this.#appServer.request(
                "thread/turns/list",
                {
                    threadId: nativeSessionId,
                    limit: Math.min(request.messageLimit, CODEX_HISTORY_TURN_PAGE_LIMIT),
                    sortDirection: "desc",
                    itemsView: "full",
                    ...(cursor.nativeCursor === null ? {} : { cursor: cursor.nativeCursor }),
                },
                signal,
            ),
        );
        signal.throwIfAborted();
        const projected = page.data
            .toReversed()
            .flatMap((turn) => turn.items)
            .flatMap((value) => {
                const item = decodeThreadItem(value);
                if (item === null) {
                    return [];
                }
                return [projectCodexHistoryMessageV3(request.sessionId, item)];
            });
        if (projected.length > MAX_PROJECTED_MESSAGES) {
            throw new NativeSessionOperationErrorV3(
                "native_history_page_too_large",
                "The Codex native history page exceeds the V3 message bound",
            );
        }
        if (cursor.skip > projected.length) {
            throw new NativeSessionOperationErrorV3("invalid_history_cursor", "The Codex history cursor is invalid");
        }
        const messages = projected.slice(cursor.skip, cursor.skip + request.messageLimit);
        const consumed = cursor.skip + messages.length;
        const nextCursor =
            consumed < projected.length
                ? encodeBufferedCursor(cursor.nativeCursor, consumed)
                : (page.nextCursor ?? null);
        const validated = sessionHistoryPageV3Schema.parse({ messages, nextCursor, throughSeq: 0 });
        return { messages: validated.messages, nextCursor: validated.nextCursor };
    };
}
