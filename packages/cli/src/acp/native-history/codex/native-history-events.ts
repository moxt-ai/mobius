import { createHash } from "node:crypto";
import type { AcpSessionUpdate, ContentBlock, SessionEventPayload } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionEventPage, SessionEventStore } from "../preview-contract.ts";
import type { NativeHistoryActivity, NativeHistoryEntry } from "./history-images.ts";

function toolKind(value: string): Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" }>["kind"] {
    switch (value) {
        case "read":
        case "edit":
        case "delete":
        case "move":
        case "search":
        case "execute":
        case "think":
        case "fetch":
        case "switch_mode":
        case "other":
            return value;
        default:
            return "other";
    }
}

function toolStatus(value: string): Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" }>["status"] {
    switch (value) {
        case "pending":
            return "pending";
        case "running":
        case "in_progress":
            return "in_progress";
        case "completed":
            return "completed";
        default:
            return "failed";
    }
}

function activityEvent(activity: NativeHistoryActivity): SessionEventPayload {
    return {
        payload: {
            content: activity.content,
            kind: toolKind(activity.toolKind),
            locations: activity.locations.map((path) => ({ path })),
            rawInput: activity.input,
            rawOutput: activity.output,
            sessionUpdate: "tool_call",
            status: toolStatus(activity.status),
            title: activity.title,
            toolCallId: activity.activityId,
            ...(activity.name.length === 0 ? {} : { name: activity.name }),
        },
        type: "acp",
    };
}

function contentEvent(
    sessionUpdate: "agent_message_chunk" | "user_message_chunk",
    messageId: string,
    content: ContentBlock,
): SessionEventPayload {
    return { payload: { content, messageId, sessionUpdate }, type: "acp" };
}

type AvailableNativeHistory = Extract<NativeHistoryEntry, { readonly status: "available" }>;

function historyEvents(history: AvailableNativeHistory): readonly SessionEventPayload[] {
    return history.messages.flatMap((message, index) => {
        const messageId = `native-history-${index.toString()}`;
        const sessionUpdate = message.role === "user" ? "user_message_chunk" : "agent_message_chunk";
        const images = (message.images ?? []).map((image) =>
            contentEvent(sessionUpdate, messageId, {
                data: image.data,
                mimeType: image.mimeType,
                type: "image",
            }),
        );
        const text =
            message.text.length === 0
                ? []
                : [contentEvent(sessionUpdate, messageId, { text: message.text, type: "text" })];
        if (message.role === "user") {
            return [...images, ...text];
        }
        const activities = message.activities.map(activityEvent);
        const content = message.content.map((block) => contentEvent(sessionUpdate, messageId, block));
        return [...activities, ...content, ...images, ...text];
    });
}

export function nativeHistoryEvents(
    sessionId: string,
    nativeSessionId: string,
    history: AvailableNativeHistory,
    eventLimit: number,
    cursor: string | null,
    eventStore: SessionEventStore,
): SessionEventPage {
    const events = historyEvents(history);
    const generationId = createHash("sha256")
        .update(nativeSessionId)
        .update("\0")
        .update(JSON.stringify(events))
        .digest("hex");
    eventStore.materialize(sessionId, generationId, events);
    return eventStore.page(sessionId, eventLimit, cursor);
}
