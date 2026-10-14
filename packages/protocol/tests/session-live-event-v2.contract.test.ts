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

    it("Given a live event with a position, When it crosses the protocol boundary, Then it is accepted without a sequence", () => {
        const event: SessionLiveEventV2 = { ...sharedEvent, position: "1" };

        expect(decodeSessionLiveEventV2(event)).toEqual(event);
    });

    it("Given a live event without a position, When it crosses the protocol boundary, Then it is rejected", () => {
        expect(() => decodeSessionLiveEventV2(sharedEvent)).toThrow();
    });
});
