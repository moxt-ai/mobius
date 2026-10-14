import { decodeSessionRecordingHistory } from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

// One event past the retired history limit, to prove the boundary no longer exists.
const HISTORY_EVENT_COUNT = 100_001;

function historyEvent(index: number) {
    return {
        eventId: `history-event-${index}`,
        position: String(index),
        provenance: { kind: "original" },
        recordedAt: "2026-10-14T00:00:00.000Z",
        sessionGenerationId: "session-generation-history",
        sessionId: "session-history",
        type: "acp",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    };
}

describe("Session Recording history contracts", () => {
    it("Given a Session longer than the retired event limit, When its full history crosses the protocol boundary, Then every event is delivered", () => {
        const events = Array.from({ length: HISTORY_EVENT_COUNT }, (_, index) => historyEvent(index));
        const encoded = JSON.stringify({ events, sessionId: "session-history" });

        expect(decodeSessionRecordingHistory(encoded).events).toHaveLength(HISTORY_EVENT_COUNT);
    });
});
