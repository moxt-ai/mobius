import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decodeSessionEventEnvelope, SESSION_EVENT_ACK_KIND } from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { SessionEventOutbox } from "../src/relay-connection/session-event-outbox.ts";

const createdDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("durable daemon session event outbox", () => {
    it("Given one Session fills the durable replay backlog, When another Session becomes ready, Then the next bounded batch serves both event sources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-event-outbox-fairness-"));
        createdDirectories.push(directory);
        const outbox = new SessionEventOutbox(join(directory, "audit.sqlite"));
        for (let sequence = 1; sequence <= 10; sequence += 1) {
            outbox.enqueue("noisy-session", JSON.stringify({ kind: "agent.activity", sequence }), "attempt-a");
        }
        outbox.enqueue("fresh-session", JSON.stringify({ kind: "session.ready" }));
        outbox.close();

        const database = new DatabaseSync(join(directory, "audit.sqlite"));
        database.exec("UPDATE relay_session_event_outbox SET source_key = ''");
        database.close();

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
