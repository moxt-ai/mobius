import { decodeSessionEventEnvelope } from "@moxt-ai/mobius-protocol";
import { expect, it } from "vitest";
import {
    RuntimeDeliveryInboxCapacityError,
    SessionEventOutbox,
    SessionEventOutboxCapacityError,
} from "../../../packages/cli/src/relay-connection/session-event-outbox.ts";

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

it("Given a long Relay disconnection, When in-memory event and delivery budgets fill, Then standard events stop before terminal events and deliveries apply backpressure", () => {
    const outbox = new SessionEventOutbox();
    try {
        const event = "x".repeat(1024 * 1024);
        for (let index = 0; index < 31; index += 1) {
            outbox.enqueue("session-a", event, "attempt-a");
        }
        expect(() => outbox.enqueue("session-a", event, "attempt-a")).toThrow(SessionEventOutboxCapacityError);
        expect(() => outbox.enqueueCritical("session-a", event, "attempt-a")).not.toThrow();

        const delivery = "y".repeat(8 * 1024 * 1024 - 2048);
        for (let index = 0; index < 4; index += 1) {
            outbox.claimRuntimeDelivery({
                deliveryId: `delivery-${index.toString()}`,
                kind: "runtime.delivery",
                payload: delivery,
                sessionId: "session-a",
            });
        }
        expect(() =>
            outbox.claimRuntimeDelivery({
                deliveryId: "delivery-over-capacity",
                kind: "runtime.delivery",
                payload: delivery,
                sessionId: "session-a",
            }),
        ).toThrow(RuntimeDeliveryInboxCapacityError);
    } finally {
        outbox.close();
    }
});
