import type { AcpSessionUpdateV2, SessionEventV2, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";

type AcpSessionEventV2 = Extract<SessionEventV2, { readonly type: "acp" }>;
type ToolCallV2 = Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;

export type SessionEventHistoryProjectionMutationV2 =
    | { readonly event: SessionEventV2; readonly kind: "append" }
    | { readonly event: SessionEventV2; readonly kind: "replace"; readonly replacedEventId: string };

function projectNewEvent(liveEvent: SessionLiveEventV2, eventId: string): SessionEventV2 {
    const { position: _position, eventId: _liveEventId, ...event } = liveEvent;
    return { ...event, eventId };
}

function replaceAcpPayload(event: AcpSessionEventV2, payload: AcpSessionUpdateV2): AcpSessionEventV2 {
    return { ...event, payload };
}

function mergeToolCall(previous: ToolCallV2, incoming: ToolCallV2): ToolCallV2 {
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

function mergeTextChunk(previous: AcpSessionUpdateV2, incoming: AcpSessionUpdateV2): AcpSessionUpdateV2 | null {
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

export class SessionEventHistoryProjectionV2 {
    readonly #allocateEventId: () => string;
    readonly #toolCalls = new Map<string, SessionEventV2>();
    #latestEvent: SessionEventV2 | null = null;

    constructor(allocateEventId: () => string) {
        this.#allocateEventId = allocateEventId;
    }

    readonly apply = (liveEvent: SessionLiveEventV2): SessionEventHistoryProjectionMutationV2 => {
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

        const event = projectNewEvent(liveEvent, this.#allocateEventId());
        this.#latestEvent = event;
        this.#indexToolCall(event);
        return { event, kind: "append" };
    };

    readonly canReplace = (eventId: string): boolean =>
        this.#latestEvent?.eventId === eventId ||
        [...this.#toolCalls.values()].some((event) => event.eventId === eventId);

    readonly #replace = (
        current: SessionEventV2,
        replacement: SessionEventV2,
    ): SessionEventHistoryProjectionMutationV2 => {
        if (this.#latestEvent?.eventId === current.eventId) {
            this.#latestEvent = replacement;
        }
        this.#indexToolCall(replacement);
        return { event: replacement, kind: "replace", replacedEventId: current.eventId };
    };

    readonly #indexToolCall = (event: SessionEventV2): void => {
        if (
            event.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            this.#toolCalls.set(event.payload.toolCallId, event);
        }
    };
}
