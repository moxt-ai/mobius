import { decodeSessionEventEnvelope } from "@moxt-ai/mobius-protocol";
import { expect, it } from "vitest";
import { SessionEventOutbox } from "../../../packages/cli/src/relay-connection/session-event-outbox.ts";

it("Given events from different Turns, When one is rejected and another is acknowledged, Then replay keeps only pending events with increasing sequence numbers", () => {
    const outbox = new SessionEventOutbox();
    try {
        const first = decodeSessionEventEnvelope(outbox.enqueue("session-a", "{}", "attempt-a"));
        const second = decodeSessionEventEnvelope(outbox.enqueue("session-b", "{}", "attempt-b"));
        expect(
            outbox.quarantine({
                code: "session_not_found",
                eventId: first.eventId,
                kind: "session.event.rejected",
                sessionId: first.sessionId,
            }),
        ).toBe(true);
        expect(
            outbox.acknowledge({
                cursor: second.eventId,
                duplicate: false,
                eventId: second.eventId,
                kind: "session.event.ack",
                sequence: "1",
                sessionId: second.sessionId,
            }),
        ).toBe(true);

        const third = decodeSessionEventEnvelope(outbox.enqueue("session-a", "{}", "attempt-c"));
        expect([first.source.sourceSeq, second.source.sourceSeq, third.source.sourceSeq]).toEqual(["1", "2", "3"]);
        expect(outbox.pending().map((encoded) => decodeSessionEventEnvelope(encoded).eventId)).toEqual([third.eventId]);
    } finally {
        outbox.close();
    }
});
