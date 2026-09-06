import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeSessionEventEnvelope,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_EVENT_ACK_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { SessionEventOutbox } from "../src/relay-connection/session-event-outbox.ts";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("durable daemon session event outbox", () => {
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
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sequence: 1,
      sessionId: firstEnvelope.sessionId,
    });
    expect(restarted.pending()).toEqual([secondEncoded]);
    expect(decodeSessionEventEnvelope(restarted.pending()[0] ?? "")).toEqual(
      decodeSessionEventEnvelope(secondEncoded),
    );
    restarted.close();
  });
});
