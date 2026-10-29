import { createHash } from "node:crypto";
import { AcpExecutionError } from "../../acp-error.ts";
import { embedLocalHistoryImages } from "../../native-history/codex/history-images.ts";
import type { CodexAppServerClient } from "./app-server-client.ts";
import { CODEX_HISTORY_TURN_PAGE_LIMIT, threadTurnsPageSchema } from "./app-server-protocol.ts";
import { decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";
import { agentMessageUpdate } from "./owned-agent.ts";
import type { CodexSessionUpdate } from "./session-update.ts";

/** Reads and projects saved items without resuming or changing the thread. */
export async function replayCodexHistory(
    client: CodexAppServerClient,
    threadId: string,
    emit: (update: CodexSessionUpdate) => Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let turnIndex = 0;
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
            for (const rawItem of turn.items) {
                deadline.throwIfAborted();
                const item = decodeThreadItem(rawItem);
                if (item === null) {
                    continue;
                }
                if (item.type === "userMessage") {
                    const contents = item.content.flatMap((content) => {
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
                    });
                    // Keep native input boundaries: joining adjacent resource links
                    // would turn the first file URL into part of the next input.
                    for (const text of contents) {
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
                                content: { text: restoredText, type: "text" },
                                messageId: item.id,
                                sessionUpdate: "user_message_chunk",
                            });
                        }
                    }
                } else if (item.type === "agentMessage") {
                    await emit(agentMessageUpdate(item.id, item.text));
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
            if (turn.error != null) {
                const identity = createHash("sha256")
                    .update(threadId)
                    .update("\0")
                    .update(turn.id ?? turnIndex.toString())
                    .digest("hex");
                await emit({
                    sessionUpdate: "tool_call",
                    toolCallId: `agent-error-${identity}`,
                    title: "Agent error",
                    kind: "other",
                    status: "failed",
                    rawOutput: { message: turn.error.message },
                    content: [{ type: "content", content: { type: "text", text: turn.error.message } }],
                });
            }
            turnIndex += 1;
        }
        if (page.nextCursor == null) {
            return;
        }
        if (page.data.length === 0 || seenCursors.has(page.nextCursor)) {
            throw new AcpExecutionError("Codex repeated a history page cursor", {}, "invalid_native_session_response");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
