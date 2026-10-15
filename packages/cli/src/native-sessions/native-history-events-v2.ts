import { createHash } from "node:crypto";
import type {
    AcpSessionUpdateV2,
    AgentDisplayContent,
    ContentBlockV2,
    NativeMessageActivity,
    NativeSessionHistory,
    SessionEventPayloadV2,
} from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplayV2 } from "../acp/session-contracts.ts";
import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";

type ToolCallContent = NonNullable<
    Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" }>["content"]
>[number];

function contentBlock(content: AgentDisplayContent): ContentBlockV2 | null {
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

function toolKind(value: string): Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" }>["kind"] {
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

function toolStatus(value: string): Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" }>["status"] {
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

function activityEvent(activity: NativeMessageActivity): SessionEventPayloadV2 {
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
    content: ContentBlockV2,
): SessionEventPayloadV2 {
    return { payload: { content, messageId, sessionUpdate }, type: "acp" };
}

type AvailableNativeSessionHistory = Extract<NativeSessionHistory, { readonly status: "available" }>;

function historyEvents(history: AvailableNativeSessionHistory): readonly SessionEventPayloadV2[] {
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

export function nativeHistoryEventsV2(
    sessionId: string,
    nativeSessionId: string,
    history: AvailableNativeSessionHistory,
    eventLimit: number,
    cursor: string | null,
    eventStore: AcpSessionEventStoreV2,
): AcpNativeEventReplayV2 {
    const events = historyEvents(history);
    // Hash event by event: one JSON string of a long transcript would double its memory.
    const digest = createHash("sha256").update(nativeSessionId).update("\0");
    for (const event of events) {
        digest.update(JSON.stringify(event)).update("\0");
    }
    const generationId = digest.digest("hex");
    eventStore.materialize(sessionId, generationId, events);
    return eventStore.page(sessionId, eventLimit, cursor);
}
