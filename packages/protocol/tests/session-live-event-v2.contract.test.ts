import {
    decodeSessionEventV2,
    decodeSessionLiveEventV2,
    type SessionEventV2,
    type SessionLiveEventV2,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

const sharedEvent = {
    eventId: "event-generation-1-0000000000000001",
    payload: {
        content: { text: "Hello", type: "text" } as const,
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk" as const,
    },
    provenance: { kind: "original" } as const,
    recordedAt: "2026-10-14T00:00:00.000Z",
    sessionGenerationId: "generation-1",
    sessionId: "session-1",
    type: "acp" as const,
};

describe("Session Event V2 contracts", () => {
    it("Given a historical event without a position, When it crosses the protocol boundary, Then it is accepted", () => {
        const event: SessionEventV2 = sharedEvent;

        expect(decodeSessionEventV2(event)).toEqual(event);
    });

    it("Given a historical event with a legacy position, When it crosses the protocol boundary, Then the position is omitted", () => {
        expect(decodeSessionEventV2({ ...sharedEvent, position: "1" })).toEqual(sharedEvent);
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

        expect(decodeSessionEventV2(event)).toEqual({
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

        expect(decodeSessionEventV2(event)).toEqual({
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

        expect(decodeSessionEventV2(event)).toEqual({
            ...event,
            payload: {
                content: { annotations: { audience: ["user"] }, text: "Hello", type: "text" },
                sessionUpdate: "agent_message_chunk",
            },
        });
    });

    it("Given a live event with a position, When it crosses the protocol boundary, Then it is accepted without a sequence", () => {
        const event: SessionLiveEventV2 = { ...sharedEvent, position: "1" };

        expect(decodeSessionLiveEventV2(event)).toEqual(event);
    });

    it("Given a live event without a position, When it crosses the protocol boundary, Then it is rejected", () => {
        expect(() => decodeSessionLiveEventV2(sharedEvent)).toThrow();
    });
});
