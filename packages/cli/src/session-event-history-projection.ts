import type { AcpSessionUpdate, SessionEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";

type AcpSessionEvent = Extract<SessionEvent, { readonly type: "acp" }>;
type ToolCall = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;

export type SessionEventHistoryProjectionMutation =
    | { readonly event: SessionEvent; readonly kind: "append" }
    | { readonly event: SessionEvent; readonly kind: "replace"; readonly replacedEventId: string };

function projectNewEvent(liveEvent: SessionLiveEvent, eventId: string): SessionEvent {
    const { position: _position, eventId: _liveEventId, ...event } = liveEvent;
    return { ...event, eventId };
}

function replaceAcpPayload(event: AcpSessionEvent, payload: AcpSessionUpdate): AcpSessionEvent {
    return { ...event, payload };
}

function mergeToolCall(previous: ToolCall, incoming: ToolCall): ToolCall {
    if (previous.sessionUpdate === "tool_call_update") {
        return { ...previous, ...incoming, sessionUpdate: "tool_call_update", toolCallId: previous.toolCallId };
    }
    const {
        content: previousContent,
        kind: previousKind,
        locations: previousLocations,
        status: previousStatus,
        title: previousTitle,
        ...previousFields
    } = previous;
    const { content, kind, locations, status, title, ...incomingFields } = incoming;
    return {
        ...previousFields,
        ...incomingFields,
        ...(content === undefined
            ? previousContent === undefined
                ? {}
                : { content: previousContent }
            : content === null
              ? {}
              : { content }),
        ...(kind === undefined
            ? previousKind === undefined
                ? {}
                : { kind: previousKind }
            : kind === null
              ? {}
              : { kind }),
        ...(locations === undefined
            ? previousLocations === undefined
                ? {}
                : { locations: previousLocations }
            : locations === null
              ? {}
              : { locations }),
        sessionUpdate: "tool_call",
        ...(status === undefined
            ? previousStatus === undefined
                ? {}
                : { status: previousStatus }
            : status === null
              ? {}
              : { status }),
        title: title ?? previousTitle,
        toolCallId: previous.toolCallId,
    };
}

function mergeTextChunk(previous: AcpSessionUpdate, incoming: AcpSessionUpdate): AcpSessionUpdate | null {
    if (
        (previous.sessionUpdate !== "agent_message_chunk" &&
            previous.sessionUpdate !== "agent_thought_chunk" &&
            previous.sessionUpdate !== "user_message_chunk") ||
        incoming.sessionUpdate !== previous.sessionUpdate ||
        previous.messageId !== incoming.messageId ||
        previous.content.type !== "text" ||
        incoming.content.type !== "text"
    ) {
        return null;
    }
    return { ...previous, content: { text: `${previous.content.text}${incoming.content.text}`, type: "text" } };
}

export class SessionEventHistoryProjection {
    readonly #toolCalls = new Map<string, SessionEvent>();
    #latestEvent: SessionEvent | null = null;

    readonly apply = (liveEvent: SessionLiveEvent): SessionEventHistoryProjectionMutation => {
        if (liveEvent.type === "acp" && liveEvent.payload.sessionUpdate === "tool_call_update") {
            const current = this.#toolCalls.get(liveEvent.payload.toolCallId);
            if (
                current?.type === "acp" &&
                (current.payload.sessionUpdate === "tool_call" || current.payload.sessionUpdate === "tool_call_update")
            ) {
                return this.#replace(
                    current,
                    replaceAcpPayload(current, mergeToolCall(current.payload, liveEvent.payload)),
                );
            }
        }

        const latest = this.#latestEvent;
        if (liveEvent.type === "acp" && latest?.type === "acp") {
            const merged = mergeTextChunk(latest.payload, liveEvent.payload);
            if (merged !== null) {
                return this.#replace(latest, replaceAcpPayload(latest, merged));
            }
        }

        const event = projectNewEvent(liveEvent, liveEvent.eventId);
        this.#latestEvent = event;
        this.#indexToolCall(event);
        return { event, kind: "append" };
    };

    readonly canReplace = (eventId: string): boolean =>
        this.#latestEvent?.eventId === eventId ||
        [...this.#toolCalls.values()].some((event) => event.eventId === eventId);

    readonly #replace = (current: SessionEvent, replacement: SessionEvent): SessionEventHistoryProjectionMutation => {
        if (this.#latestEvent?.eventId === current.eventId) {
            this.#latestEvent = replacement;
        }
        this.#indexToolCall(replacement);
        return { event: replacement, kind: "replace", replacedEventId: current.eventId };
    };

    readonly #indexToolCall = (event: SessionEvent): void => {
        if (
            event.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            this.#toolCalls.set(event.payload.toolCallId, event);
        }
    };
}
