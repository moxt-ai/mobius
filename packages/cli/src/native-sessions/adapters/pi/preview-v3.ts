import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionHistoryMessageV3 } from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { NativeSessionOperationErrorV3, type NativeSessionPreviewAdapterV3 } from "../adapter-v3.ts";

const textBlockSchema = z.object({ text: z.string().max(1_000_000), type: z.literal("text") });
const thinkingBlockSchema = z.object({ thinking: z.string().max(1_000_000), type: z.literal("thinking") });
const toolCallBlockSchema = z.object({
    id: z.string().min(1).max(2_048),
    name: z.string().max(2_048),
    type: z.literal("toolCall"),
});
const sessionEntrySchema = z
    .object({
        id: z.string().min(1).max(2_048),
        type: z.string().min(1).max(128),
    })
    .passthrough();
const messageEntrySchema = sessionEntrySchema.extend({
    message: z.discriminatedUnion("role", [
        z.object({
            content: z.union([z.string().max(1_000_000), z.array(z.unknown()).max(1_000)]),
            role: z.literal("user"),
        }),
        z.object({ content: z.array(z.unknown()).max(1_000), role: z.literal("assistant") }),
        z.object({
            content: z.array(z.unknown()).max(1_000),
            isError: z.boolean(),
            role: z.literal("toolResult"),
            toolCallId: z.string().min(1).max(2_048),
            toolName: z.string().max(2_048),
        }),
    ]),
    type: z.literal("message"),
});
const summaryEntrySchema = sessionEntrySchema.extend({
    summary: z.string().max(1_000_000),
    type: z.enum(["branch_summary", "compaction"]),
});
const customMessageEntrySchema = sessionEntrySchema.extend({
    content: z.union([z.string().max(1_000_000), z.array(z.unknown()).max(1_000)]),
    type: z.literal("custom_message"),
});

function textContent(
    content: string | readonly unknown[],
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
            const thinking = thinkingBlockSchema.safeParse(block);
            return thinking.success ? [thinking.data.thinking] : [];
        })
        .join("");
    return text.length === 0 ? [] : [{ text, type: "text" }];
}

function projectEntry(sessionId: string, value: unknown): SessionHistoryMessageV3 | null {
    const messageEntry = messageEntrySchema.safeParse(value);
    if (messageEntry.success) {
        const { id, message } = messageEntry.data;
        if (message.role === "assistant") {
            for (const block of message.content) {
                const tool = toolCallBlockSchema.safeParse(block);
                if (tool.success) {
                    return {
                        item: {
                            name: tool.data.name,
                            status: "completed",
                            title: tool.data.name,
                            toolCallId: tool.data.id,
                            sessionUpdate: "tool_call",
                        },
                        messageId: id,
                        sessionId,
                    };
                }
            }
        }
        if (message.role === "toolResult") {
            return {
                item: {
                    content: textContent(message.content).map((content) => ({ content, type: "content" })),
                    name: message.toolName,
                    status: message.isError ? "failed" : "completed",
                    title: message.toolName,
                    toolCallId: message.toolCallId,
                    sessionUpdate: "tool_call",
                },
                messageId: id,
                sessionId,
            };
        }
        return {
            item: {
                content: textContent(message.content),
                sessionUpdate: message.role === "assistant" ? "agent_message" : "user_message",
            },
            messageId: id,
            sessionId,
        };
    }
    const summary = summaryEntrySchema.safeParse(value);
    if (summary.success) {
        return {
            item: { content: [{ text: summary.data.summary, type: "text" }], sessionUpdate: "agent_message" },
            messageId: summary.data.id,
            sessionId,
        };
    }
    const custom = customMessageEntrySchema.safeParse(value);
    if (custom.success) {
        return {
            item: { content: textContent(custom.data.content), sessionUpdate: "user_message" },
            messageId: custom.data.id,
            sessionId,
        };
    }
    return null;
}

export class PiNativeSessionPreviewAdapterV3 implements NativeSessionPreviewAdapterV3 {
    readonly #sessionDirectory: string | undefined;

    constructor(sessionDirectory?: string) {
        this.#sessionDirectory = sessionDirectory;
    }

    readonly previewMessages: NativeSessionPreviewAdapterV3["previewMessages"] = async (session, request, signal) => {
        signal.throwIfAborted();
        const sessionFile = SessionManager.findById(session.cwd, session.nativeSessionId, this.#sessionDirectory);
        if (sessionFile === undefined) {
            throw new NativeSessionOperationErrorV3("session_not_found", "The Pi Session was not found");
        }
        const manager = SessionManager.open(sessionFile, this.#sessionDirectory, session.cwd);
        if (manager.getSessionId() !== session.nativeSessionId) {
            throw new NativeSessionOperationErrorV3(
                "session_identity_mismatch",
                "The Pi Session identity does not match",
            );
        }
        const nativeEntries: unknown = manager.getBranch();
        const decodedEntries = z.array(sessionEntrySchema).safeParse(nativeEntries);
        if (!decodedEntries.success) {
            throw new NativeSessionOperationErrorV3(
                "invalid_native_session_response",
                "The Pi Session history is invalid",
                { cause: decodedEntries.error },
            );
        }
        const entries = decodedEntries.data;
        const cursorIndex = request.cursor === null ? -1 : entries.findIndex((entry) => entry.id === request.cursor);
        if (request.cursor !== null && cursorIndex < 0) {
            throw new NativeSessionOperationErrorV3("invalid_history_cursor", "The Pi history cursor is invalid");
        }
        const messages: SessionHistoryMessageV3[] = [];
        let index = cursorIndex + 1;
        while (index < entries.length && messages.length < request.messageLimit) {
            signal.throwIfAborted();
            const projected = projectEntry(request.sessionId, entries[index]);
            if (projected !== null) {
                messages.push(projected);
            }
            index += 1;
        }
        return {
            messages,
            nextCursor: index < entries.length ? (entries[index - 1]?.id ?? null) : null,
            throughSeq: 0,
        };
    };
}
