import type { SessionNotification } from "@agentclientprotocol/sdk";
import { SESSION_HISTORY_CHARACTER_LIMIT } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp-error.ts";
import { embedLocalHistoryImages } from "../../native-history/codex/history-images.ts";
import type { CodexAppServerClient } from "./app-server-client.ts";
import { CODEX_HISTORY_TURN_PAGE_LIMIT, threadTurnsPageSchema } from "./app-server-protocol.ts";
import { decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";
import { agentMessageUpdate } from "./owned-agent.ts";

/** Reads and projects saved items without resuming or changing the thread. */
export async function replayCodexHistory(
    client: CodexAppServerClient,
    threadId: string,
    emit: (update: SessionNotification["update"]) => Promise<void>,
    signal: AbortSignal,
): Promise<{ readonly truncated: boolean }> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let truncated = false;
    for (;;) {
        deadline.throwIfAborted();
        const page = threadTurnsPageSchema.parse(
            await client.request(
                "thread/turns/list",
                {
                    threadId,
                    limit: CODEX_HISTORY_TURN_PAGE_LIMIT,
                    sortDirection: "asc",
                    itemsView: "full",
                    ...(cursor === null ? {} : { cursor }),
                },
                deadline,
            ),
        );
        for (const turn of page.data) {
            // Leave room for the event envelope alongside each bounded text item.
            const textLimit = Math.max(
                0,
                Math.floor(SESSION_HISTORY_CHARACTER_LIMIT / Math.max(1, turn.items.length)) - 1_024,
            );
            const boundedText = (text: string): string => {
                truncated ||= text.length > textLimit;
                return text.slice(0, textLimit);
            };
            for (const rawItem of turn.items) {
                deadline.throwIfAborted();
                const item = decodeThreadItem(rawItem);
                if (item === null) {
                    continue;
                }
                if (item.type === "userMessage") {
                    const text = item.content
                        .flatMap((content) => {
                            if (typeof content !== "object" || content === null) {
                                return [];
                            }
                            const type = Reflect.get(content, "type");
                            const text = Reflect.get(content, "text");
                            const url = Reflect.get(content, "url");
                            if (type === "image" && typeof url === "string") {
                                return [`[@image](${url})`];
                            }
                            return type === "text" && typeof text === "string" ? [text] : [];
                        })
                        .join("");
                    const history = await embedLocalHistoryImages(
                        { status: "available", truncated: false, messages: [{ role: "user", text }] },
                        deadline,
                    );
                    if (history.status !== "available") {
                        continue;
                    }
                    const message = history.messages[0];
                    for (const image of message?.images ?? []) {
                        await emit({
                            content: { type: "image", data: image.data, mimeType: image.mimeType },
                            messageId: item.id,
                            sessionUpdate: "user_message_chunk",
                        });
                    }
                    const restoredText = message?.text ?? "";
                    if (restoredText.length > 0) {
                        await emit({
                            content: { text: boundedText(restoredText), type: "text" },
                            messageId: item.id,
                            sessionUpdate: "user_message_chunk",
                        });
                    }
                } else if (item.type === "agentMessage") {
                    await emit(agentMessageUpdate(item.id, boundedText(item.text)));
                } else if (item.type === "reasoning") {
                    const text = reasoningText(item);
                    if (text !== null && text.length > 0) {
                        await emit({
                            content: { text, type: "text" },
                            messageId: item.id,
                            sessionUpdate: "agent_thought_chunk",
                        });
                    }
                } else if (item.type === "contextCompaction") {
                    await emit({ compactionId: item.id, sessionUpdate: "compaction_update", status: "completed" });
                } else {
                    const update = toolCallUpdate(item, "snapshot");
                    if (update !== null) {
                        await emit({ ...update, sessionUpdate: "tool_call" });
                    }
                }
            }
        }
        if (page.nextCursor == null) {
            return { truncated };
        }
        if (page.data.length === 0 || seenCursors.has(page.nextCursor)) {
            throw new AcpExecutionError("Codex repeated a history page cursor", {}, "invalid_native_session_response");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
