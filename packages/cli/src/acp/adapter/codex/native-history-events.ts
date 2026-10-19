import { createHash } from "node:crypto";
import type {
    AcpSessionUpdate,
    AgentDisplayContent,
    ContentBlock,
    SessionEventPayload,
} from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplay } from "../../session-contracts.ts";
import type { AcpSessionEventStore } from "../../session-event-store.ts";
import type { NativeHistoryActivity, NativeHistoryEntry } from "./history-images.ts";

type ToolCallContent = NonNullable<
    Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" }>["content"]
>[number];

function contentBlock(content: AgentDisplayContent): ContentBlock | null {
    switch (content.type) {
        case "text":
            return { text: content.text, type: "text" };
        case "image":
            return {
                data: content.data,
                mimeType: content.mimeType,
                type: "image",
                ...(content.uri.length === 0 ? {} : { uri: content.uri }),
            };
        case "resource_link":
            return {
                name: content.name.length === 0 ? content.uri : content.name,
                type: "resource_link",
                uri: content.uri,
                ...(content.mimeType.length === 0 ? {} : { mimeType: content.mimeType }),
            };
        case "resource":
            return {
                resource:
                    content.text.length > 0
                        ? {
                              text: content.text,
                              uri: content.uri,
                              ...(content.mimeType.length === 0 ? {} : { mimeType: content.mimeType }),
                          }
                        : {
                              blob: content.data,
                              uri: content.uri,
                              ...(content.mimeType.length === 0 ? {} : { mimeType: content.mimeType }),
                          },
                type: "resource",
            };
        case "diff":
        case "terminal":
        case "video":
            return null;
        default: {
            const unhandled: never = content.type;
            throw new Error(`Unknown native history content: ${String(unhandled)}`);
        }
    }
}

function toolContent(content: AgentDisplayContent): ToolCallContent | null {
    if (content.type === "diff") {
        return {
            newText: content.newText,
            path: content.path,
            type: "diff",
            ...(content.oldText.length === 0 ? {} : { oldText: content.oldText }),
        };
    }
    if (content.type === "terminal") {
        return { terminalId: content.terminalId, type: "terminal" };
    }
    const block = contentBlock(content);
    return block === null ? null : { content: block, type: "content" };
}

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
    const content = activity.content.flatMap((item) => {
        const converted = toolContent(item);
        return converted === null ? [] : [converted];
    });
    return {
        payload: {
            content,
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
        const content = message.content.flatMap((item) => {
            const converted = contentBlock(item);
            return converted === null ? [] : [contentEvent(sessionUpdate, messageId, converted)];
        });
        return [...activities, ...content, ...images, ...text];
    });
}

export function nativeHistoryEvents(
    sessionId: string,
    nativeSessionId: string,
    history: AvailableNativeHistory,
    eventLimit: number,
    cursor: string | null,
    eventStore: AcpSessionEventStore,
): AcpNativeEventReplay {
    const events = historyEvents(history);
    const generationId = createHash("sha256")
        .update(nativeSessionId)
        .update("\0")
        .update(JSON.stringify(events))
        .digest("hex");
    eventStore.materialize(sessionId, generationId, events);
    return eventStore.page(sessionId, eventLimit, cursor);
}
