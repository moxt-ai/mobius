import {
    decodeDaemonToRelayMessage,
    decodeSessionEvent,
    decodeSessionLiveEvent,
    encodeSessionEvent,
    type SessionEvent,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

const eventWithoutProvenance = {
    eventId: "event-generation-1-0000000000000001",
    payload: {
        content: { text: "Hello", type: "text" } as const,
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk" as const,
    },
    recordedAt: "2026-10-14T00:00:00.000Z",
    sessionGenerationId: "generation-1",
    sessionId: "session-1",
    type: "acp" as const,
};
const sharedEvent = eventWithoutProvenance;

describe("Session Event V2 contracts", () => {
    it("Given the lossless relay boundary, When routing metadata or batch bounds are invalid, Then it rejects the envelope", () => {
        const event = { ...sharedEvent, position: "1" };
        for (const events of [
            [],
            Array.from({ length: 1001 }, () => event),
            [{ ...event, sessionId: "" }],
            [{ ...event, eventId: "" }],
            [{ ...event, sessionGenerationId: "" }],
            [{ ...event, position: "-1" }],
            [{ ...event, recordedAt: "not-a-date" }],
            [{ ...event, payload: null }],
            [{ ...event, type: "lifecycle-metadata", payload: { kind: "prompt.completed", commandId: 5 } }],
        ]) {
            expect(() => decodeDaemonToRelayMessage(JSON.stringify({ kind: "session.event.v2", events }))).toThrow();
        }
    });

    it("Given lifecycle metadata, When decoded as history or live traffic, Then only the live boundary accepts it", () => {
        const { position, ...history } = {
            ...sharedEvent,
            type: "lifecycle-metadata" as const,
            payload: { kind: "prompt.completed" as const, commandId: "command-1", stopReason: "end_turn" },
            position: "1",
        };

        expect(() => decodeSessionEvent(history)).toThrow();
        expect(decodeSessionLiveEvent({ ...history, position })).toEqual({ ...history, position });
    });

    it("Given a large legacy inline image, When its recorded event crosses the protocol boundary, Then it is accepted", () => {
        const event = {
            ...sharedEvent,
            payload: {
                content: { data: "a".repeat(1_000_001), mimeType: "image/png", type: "image" as const },
                sessionUpdate: "agent_message_chunk" as const,
            },
        };

        expect(decodeSessionEvent(event)).toEqual(event);
        expect(JSON.parse(encodeSessionEvent(event))).toEqual(event);
    });

    it.each(["running", "completed", "failed", "stopped", "unknown"])(
        "Given a %s background task, When a tool update crosses the recorded event boundary, Then its explicit task status survives",
        (status) => {
            const event = {
                ...sharedEvent,
                payload: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "tool-1",
                    backgroundTask: { id: "task-1", status },
                },
            };
            expect(decodeSessionEvent(event)).toEqual(event);
            expect(() =>
                decodeSessionEvent({
                    ...event,
                    payload: { ...event.payload, backgroundTask: { id: "task-1", status: "invented" } },
                }),
            ).toThrow();
        },
    );

    it("Given a session event, When it crosses the protocol boundary, Then it is accepted", () => {
        expect(decodeSessionEvent(eventWithoutProvenance)).toEqual(eventWithoutProvenance);
    });

    it("Given a historical event without a position, When it crosses the protocol boundary, Then it is accepted", () => {
        const event: SessionEvent = sharedEvent;

        expect(decodeSessionEvent(event)).toEqual(event);
    });

    it("Given a historical event with a legacy position, When it crosses the protocol boundary, Then the position is omitted", () => {
        expect(decodeSessionEvent({ ...sharedEvent, position: "1" })).toEqual(sharedEvent);
    });

    it("Given a tool call with opaque metadata, When it crosses the recorded event boundary, Then the metadata is omitted", () => {
        const event = {
            ...sharedEvent,
            payload: {
                _meta: { terminal_info: { terminal_id: "tool-1" } },
                sessionUpdate: "tool_call",
                title: "Run command",
                toolCallId: "tool-1",
            },
        };

        expect(decodeSessionEvent(event)).toEqual({
            ...event,
            payload: {
                sessionUpdate: "tool_call",
                title: "Run command",
                toolCallId: "tool-1",
            },
        });
    });

    it("Given a tool call update with opaque metadata, When it crosses the recorded event boundary, Then the metadata is omitted", () => {
        const event = {
            ...sharedEvent,
            payload: {
                _meta: { terminal_output: { data: "output", terminal_id: "tool-1" } },
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
            },
        };

        expect(decodeSessionEvent(event)).toEqual({
            ...event,
            payload: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
            },
        });
    });

    it("Given opaque metadata throughout an ACP update, When it crosses the recorded event boundary, Then all metadata is omitted", () => {
        const event = {
            ...sharedEvent,
            payload: {
                _meta: { source: "agent" },
                content: {
                    _meta: { source: "content" },
                    annotations: { _meta: { source: "annotations" }, audience: ["user"] },
                    text: "Hello",
                    type: "text",
                },
                sessionUpdate: "agent_message_chunk",
            },
        };

        expect(decodeSessionEvent(event)).toEqual({
            ...event,
            payload: {
                content: { annotations: { audience: ["user"] }, text: "Hello", type: "text" },
                sessionUpdate: "agent_message_chunk",
            },
        });
    });

    it("Given externalized tool content with opaque metadata, When it crosses the recorded event boundary, Then the metadata is omitted", () => {
        const event = {
            ...sharedEvent,
            payload: {
                content: [
                    {
                        content: {
                            _meta: { source: "agent" },
                            byteLength: 68,
                            imageKey: "a".repeat(64),
                            mimeType: "image/png",
                            type: "external_image",
                        },
                        type: "content",
                    },
                ],
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
            },
        };

        expect(decodeSessionEvent(event)).toEqual({
            ...event,
            payload: {
                content: [
                    {
                        content: {
                            byteLength: 68,
                            imageKey: "a".repeat(64),
                            mimeType: "image/png",
                            type: "external_image",
                        },
                        type: "content",
                    },
                ],
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
            },
        });
    });

    it("Given a live event with a position, When it crosses the protocol boundary, Then it is accepted without a sequence", () => {
        const event: SessionLiveEvent = { ...sharedEvent, position: "1" };

        expect(decodeSessionLiveEvent(event)).toEqual(event);
    });

    it("Given a live event without a position, When it crosses the protocol boundary, Then it is rejected", () => {
        expect(() => decodeSessionLiveEvent(sharedEvent)).toThrow();
    });
});
