import type { AcpSessionUpdate, SessionEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";

export type { ProjectedToolCall } from "../../acp/tool-call-projection.ts";

type AcpSessionEvent = Extract<SessionEvent, { readonly type: "acp" }>;
type ToolCall = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
type Reasoning = Extract<AcpSessionUpdate, { readonly sessionUpdate: "agent_thought_chunk" }>;

const MAXIMUM_PROJECTED_REASONING_BYTES = 24 * 1024;

function boundReasoning(payload: Reasoning): Reasoning {
    if (
        payload.content.type !== "text" ||
        Buffer.byteLength(payload.content.text, "utf8") <= MAXIMUM_PROJECTED_REASONING_BYTES
    ) {
        return payload;
    }
    const bytes = Buffer.from(payload.content.text, "utf8");
    let start = bytes.length - MAXIMUM_PROJECTED_REASONING_BYTES;
    // Retain a UTF-8 tail without starting inside a code point.
    while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80) {
        start += 1;
    }
    return {
        ...payload,
        content: { ...payload.content, text: bytes.toString("utf8", start) },
        meta: { ...payload.meta, truncated: true },
    };
}

export type SessionEventHistoryProjectionMutation =
    | { readonly kind: "skip" }
    | { readonly events: readonly AcpSessionEvent[]; readonly kind: "append" }
    | { readonly event: SessionEvent; readonly kind: "replace"; readonly replacedEventId: string };

/**
 * Resolves the current projected payloads of events by their identifiers, in
 * batch. The resolver materializes events whose payloads are no longer held in
 * memory, so merge targets can live on a slower tier.
 */
export type MaterializedEventsResolver = (eventIds: readonly string[]) => ReadonlyMap<string, SessionEvent>;

function projectNewEvent(
    liveEvent: Extract<SessionLiveEvent, { readonly type: "acp" }>,
    eventId: string,
): AcpSessionEvent {
    const { position: _position, eventId: _liveEventId, ...event } = liveEvent;
    if (event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk") {
        return { ...event, eventId, payload: boundReasoning(event.payload) };
    }
    return { ...event, eventId };
}

function replaceAcpPayload(event: AcpSessionEvent, payload: AcpSessionUpdate): AcpSessionEvent {
    return { ...event, payload };
}

/**
 * ACP v1 treats omission and `null` as equivalent on a tool call update:
 * both leave the previously reported value unchanged. There is no way to
 * clear a field once it has a value, so an update only contributes fields
 * it actually carries.
 */
function patchToolCallFields<T extends ToolCall>(previous: T, incoming: ToolCall): T {
    const {
        content: previousContent,
        kind: previousKind,
        locations: previousLocations,
        rawInput: previousRawInput,
        rawOutput: previousRawOutput,
        status: previousStatus,
        title: previousTitle,
        ...previousFields
    } = previous;
    const { content, kind, locations, rawInput, rawOutput, status, title, ...incomingFields } = incoming;
    return {
        ...previousFields,
        ...incomingFields,
        ...(content === undefined || content === null
            ? previousContent === undefined || previousContent === null
                ? {}
                : { content: previousContent }
            : { content }),
        ...(kind === undefined || kind === null
            ? previousKind === undefined || previousKind === null
                ? {}
                : { kind: previousKind }
            : { kind }),
        ...(locations === undefined || locations === null
            ? previousLocations === undefined || previousLocations === null
                ? {}
                : { locations: previousLocations }
            : { locations }),
        ...(rawInput === undefined || rawInput === null
            ? previousRawInput === undefined || previousRawInput === null
                ? {}
                : { rawInput: previousRawInput }
            : { rawInput }),
        ...(rawOutput === undefined || rawOutput === null
            ? previousRawOutput === undefined || previousRawOutput === null
                ? {}
                : { rawOutput: previousRawOutput }
            : { rawOutput }),
        ...(status === undefined || status === null
            ? previousStatus === undefined || previousStatus === null
                ? {}
                : { status: previousStatus }
            : { status }),
        // A tool call always carries a title in the session event log, so the
        // merged form keeps the announced one when an update omits it.
        title: title ?? previousTitle,
        toolCallId: previous.toolCallId,
    } as T;
}

function mergeToolCall(previous: ToolCall, incoming: ToolCall): ToolCall {
    if (previous.sessionUpdate === "tool_call_update") {
        return {
            ...patchToolCallFields(previous, incoming),
            sessionUpdate: "tool_call_update",
        };
    }
    return {
        ...patchToolCallFields(previous, incoming),
        sessionUpdate: "tool_call",
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
    const content = { text: `${previous.content.text}${incoming.content.text}`, type: "text" as const };
    if (previous.sessionUpdate === "agent_thought_chunk" && incoming.sessionUpdate === "agent_thought_chunk") {
        return boundReasoning({
            ...previous,
            content,
            ...(previous.meta?.truncated === true || incoming.meta?.truncated === true
                ? { meta: { ...previous.meta, ...incoming.meta, truncated: true } }
                : {}),
        });
    }
    return { ...previous, content };
}

export class SessionEventHistoryProjection {
    readonly #toolCallEventIds = new Map<string, string>();
    #latestEvent: SessionEvent | null = null;

    readonly apply = (
        liveEvent: SessionLiveEvent,
        resolve: MaterializedEventsResolver,
    ): SessionEventHistoryProjectionMutation => {
        if (liveEvent.type === "lifecycle-metadata") {
            this.#latestEvent = null;
            const prompt = liveEvent.payload;
            if (prompt.kind === "prompt.requested") {
                // Retain user content, not the execution lifecycle envelope. Keep the
                // first identity so a history handoff replaces the live prompt bubble.
                const events = prompt.content.map(
                    (content, index): AcpSessionEvent => ({
                        eventId: index === 0 ? liveEvent.eventId : `${liveEvent.eventId}-content-${index}`,
                        payload: { content, messageId: liveEvent.eventId, sessionUpdate: "user_message_chunk" },
                        recordedAt: liveEvent.recordedAt,
                        sessionGenerationId: liveEvent.sessionGenerationId,
                        sessionId: liveEvent.sessionId,
                        type: "acp",
                    }),
                );
                return { events, kind: "append" };
            }
            return { kind: "skip" };
        }
        if (liveEvent.type === "acp" && liveEvent.payload.sessionUpdate === "tool_call_update") {
            const targetEventId = this.#toolCallEventIds.get(liveEvent.payload.toolCallId);
            const current = targetEventId === undefined ? undefined : resolve([targetEventId]).get(targetEventId);
            if (
                current?.type === "acp" &&
                (current.payload.sessionUpdate === "tool_call" || current.payload.sessionUpdate === "tool_call_update")
            ) {
                return this.#replace(
                    current,
                    replaceAcpPayload(current, mergeToolCall(current.payload, liveEvent.payload)),
                );
            }
            // The target cannot be materialized (for example an undecodable
            // cache row), so the update is recorded as its own event instead.
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
        return { events: [event], kind: "append" };
    };

    /**
     * The projected tool call announced with this identifier, in its current
     * merged form, or `undefined` when the projection has not recorded one.
     */
    readonly getToolCall = (toolCallId: string, resolve: MaterializedEventsResolver): ToolCall | undefined => {
        const eventId = this.#toolCallEventIds.get(toolCallId);
        if (eventId === undefined) {
            return undefined;
        }
        const event = resolve([eventId]).get(eventId);
        if (
            event?.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            return event.payload;
        }
        return undefined;
    };

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
            this.#toolCallEventIds.set(event.payload.toolCallId, event.eventId);
        }
    };
}
