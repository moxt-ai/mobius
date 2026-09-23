import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeSessionEventEnvelope,
    RUNTIME_DELIVERY_KIND,
    type RuntimeDelivery,
    SESSION_EVENT_ACK_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
    RuntimeDeliveryInboxCapacityError,
    SessionEventOutbox,
    SessionEventOutboxCapacityError,
} from "../../../packages/cli/src/relay-connection/session-event-outbox.ts";

const createdDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("durable daemon session event outbox", () => {
    it("Given Runtime deliveries can complete on either side of a reconnect, When daemon receipt and Relay confirmation arrive in either order, Then each command remains durable and is released exactly once", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-delivery-inbox-"));
        createdDirectories.push(directory);
        const databasePath = join(directory, "audit.sqlite");
        const limits = {
            criticalEventBytes: 4_096,
            standardEventBytes: 2_048,
            runtimeDeliveryCount: 2,
            runtimeDeliveryBytes: 8_192,
        };
        const processedFirst: RuntimeDelivery = {
            deliveryId: "delivery-processed-first",
            kind: RUNTIME_DELIVERY_KIND,
            payload: JSON.stringify({ kind: "session.prompt", sessionId: "session-a" }),
            sessionId: "session-a",
        };
        const committedFirst: RuntimeDelivery = {
            deliveryId: "delivery-committed-first",
            kind: RUNTIME_DELIVERY_KIND,
            payload: JSON.stringify({ kind: "session.cancel", sessionId: "session-b" }),
            sessionId: "session-b",
        };
        const first = new SessionEventOutbox(databasePath, limits);
        expect(first.claimRuntimeDelivery(processedFirst)).toMatchObject({ duplicate: false, state: "received" });
        expect(first.markRuntimeDeliveryProcessed(processedFirst.deliveryId, processedFirst.sessionId)).toBe(true);
        expect(first.claimRuntimeDelivery(committedFirst)).toMatchObject({ duplicate: false, state: "received" });
        expect(first.markRuntimeDeliveryCommitted(committedFirst.deliveryId, committedFirst.sessionId)).toBe(true);
        expect(() =>
            first.claimRuntimeDelivery({
                deliveryId: "delivery-over-capacity",
                kind: RUNTIME_DELIVERY_KIND,
                payload: JSON.stringify({ kind: "session.cancel", sessionId: "session-c" }),
                sessionId: "session-c",
            }),
        ).toThrowError(RuntimeDeliveryInboxCapacityError);
        first.close();

        const restarted = new SessionEventOutbox(databasePath, limits);
        expect(restarted.claimRuntimeDelivery(processedFirst)).toMatchObject({ duplicate: true, state: "processed" });
        expect(restarted.claimRuntimeDelivery(committedFirst)).toMatchObject({
            duplicate: true,
            state: "relay_committed",
        });
        expect(restarted.markRuntimeDeliveryCommitted(processedFirst.deliveryId, processedFirst.sessionId)).toBe(true);
        expect(restarted.markRuntimeDeliveryProcessed(committedFirst.deliveryId, committedFirst.sessionId)).toBe(true);
        expect(restarted.runtimeDeliveries()).toEqual([]);
        restarted.close();
    });

    it("Given Relay acknowledgements stop draining the local event outbox, When compact events accumulate and then exhaust its byte capacity, Then event count stays independent from task duration while reserved terminal capacity remains usable", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-event-outbox-capacity-"));
        createdDirectories.push(directory);
        const outbox = new SessionEventOutbox(join(directory, "audit.sqlite"), {
            criticalEventBytes: 4_096,
            standardEventBytes: 2_048,
            runtimeDeliveryCount: 4,
            runtimeDeliveryBytes: 8_192,
        });
        outbox.enqueue("session-a", JSON.stringify({ kind: "agent.message.delta", text: "first" }));
        outbox.enqueue("session-a", JSON.stringify({ kind: "agent.message.delta", text: "second" }));
        expect(() =>
            outbox.enqueue("session-a", JSON.stringify({ kind: "agent.message.delta", text: "third" })),
        ).not.toThrow();

        expect(() =>
            outbox.enqueue("session-a", JSON.stringify({ kind: "agent.message.delta", text: "x".repeat(2_048) })),
        ).toThrowError(SessionEventOutboxCapacityError);
        expect(() =>
            outbox.enqueueCritical("session-a", JSON.stringify({ kind: "session.failed", message: "bounded" })),
        ).not.toThrow();

        for (const [index, encoded] of outbox.pending().slice(0, 3).entries()) {
            const event = decodeSessionEventEnvelope(encoded);
            outbox.acknowledge({
                cursor: `cursor-capacity-${index.toString()}`,
                duplicate: false,
                eventId: event.eventId,
                kind: SESSION_EVENT_ACK_KIND,
                sequence: (index + 1).toString(),
                sessionId: event.sessionId,
            });
        }
        expect(() =>
            outbox.enqueue("session-a", JSON.stringify({ kind: "agent.message.delta", text: "admitted" })),
        ).not.toThrow();
        outbox.close();
    });

    it("Given one Session fills the durable replay backlog, When another Session becomes ready, Then the next bounded batch serves both event sources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-event-outbox-fairness-"));
        createdDirectories.push(directory);
        const outbox = new SessionEventOutbox(join(directory, "audit.sqlite"));
        for (let sequence = 1; sequence <= 10; sequence += 1) {
            outbox.enqueue("noisy-session", JSON.stringify({ kind: "agent.activity", sequence }), "attempt-a");
        }
        outbox.enqueue("fresh-session", JSON.stringify({ kind: "session.ready" }));
        outbox.close();

        const restarted = new SessionEventOutbox(join(directory, "audit.sqlite"));

        const batch = restarted.pendingBatch(4).map((encoded) => decodeSessionEventEnvelope(encoded));

        expect(
            batch.map((event) => ({
                sessionId: event.sessionId,
                sourceSeq: event.source.sourceSeq,
            })),
        ).toEqual([
            { sessionId: "noisy-session", sourceSeq: "1" },
            { sessionId: "fresh-session", sourceSeq: "1" },
            { sessionId: "noisy-session", sourceSeq: "2" },
            { sessionId: "noisy-session", sourceSeq: "3" },
        ]);
        restarted.close();
    });

    it("Given unacknowledged ordered events, When the daemon restarts and acknowledges one, Then only the remaining envelope is retransmitted without a new event identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-event-outbox-"));
        createdDirectories.push(directory);
        const databasePath = join(directory, "audit.sqlite");
        const first = new SessionEventOutbox(databasePath);
        const firstEncoded = first.enqueue("session-a", '{"kind":"first"}');
        const secondEncoded = first.enqueue("session-a", '{"kind":"second"}');
        first.close();

        const restarted = new SessionEventOutbox(databasePath);
        expect(restarted.pending()).toEqual([firstEncoded, secondEncoded]);
        const firstEnvelope = decodeSessionEventEnvelope(firstEncoded);
        restarted.acknowledge({
            cursor: "cursor-a",
            duplicate: false,
            eventId: firstEnvelope.eventId,
            kind: SESSION_EVENT_ACK_KIND,
            sequence: "1",
            sessionId: firstEnvelope.sessionId,
        });
        expect(restarted.pending()).toEqual([secondEncoded]);
        expect(decodeSessionEventEnvelope(restarted.pending()[0] ?? "")).toEqual(
            decodeSessionEventEnvelope(secondEncoded),
        );
        restarted.close();
    });

    it("Given a durably claimed Turn, When the daemon restarts and receives the same dispatch, Then it returns the original Attempt receipt without authorizing a second execution", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-turn-receipt-"));
        createdDirectories.push(directory);
        const databasePath = join(directory, "audit.sqlite");
        const command = JSON.stringify({ kind: "session.prompt", prompt: "run" });
        const first = new SessionEventOutbox(databasePath);
        const accepted = first.claimExecution("command-a", "session-a", command);
        expect(accepted).toMatchObject({
            commandId: "command-a",
            kind: "accepted",
            state: "dispatching",
        });
        first.transitionExecution("command-a", "running");
        first.close();

        const restarted = new SessionEventOutbox(databasePath);
        expect(restarted.claimExecution("command-a", "session-a", command)).toEqual({
            ...accepted,
            kind: "duplicate",
            state: "running",
        });
        expect(() =>
            restarted.claimExecution(
                "command-a",
                "session-a",
                JSON.stringify({ kind: "session.prompt", prompt: "changed" }),
            ),
        ).toThrow("conflicts with its durable receipt");
        restarted.transitionExecution("command-a", "succeeded");
        expect(() => restarted.transitionExecution("command-a", "running")).toThrow("transition is invalid");
        restarted.close();
    });
});
