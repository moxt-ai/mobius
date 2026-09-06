import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  encodeSessionEventEnvelope,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_EVENT_FORMAT_VERSION,
  SESSION_EVENT_KIND,
  type SessionEventAcknowledgement,
  type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";

function readPendingEnvelope(row: unknown): string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("SQLite returned an invalid session event outbox row");
  }
  const envelope = Reflect.get(row, "envelope_json");
  if (typeof envelope !== "string") {
    throw new Error("SQLite returned an invalid session event envelope");
  }
  return envelope;
}

export class SessionEventOutbox {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS relay_session_event_outbox (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relay_session_event_outbox_order
        ON relay_session_event_outbox(ordinal);
    `);
  }

  readonly acknowledge = (
    acknowledgement: SessionEventAcknowledgement,
  ): void => {
    this.#database
      .prepare(
        `DELETE FROM relay_session_event_outbox
         WHERE event_id = ? AND session_id = ?`,
      )
      .run(acknowledgement.eventId, acknowledgement.sessionId);
  };

  readonly close = (): void => {
    this.#database.close();
  };

  readonly enqueue = (sessionId: string, payload: string): string => {
    const envelope: SessionEventEnvelope = {
      eventId: crypto.randomUUID(),
      eventVersion: SESSION_EVENT_FORMAT_VERSION,
      kind: SESSION_EVENT_KIND,
      payload,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId,
    };
    const encoded = encodeSessionEventEnvelope(envelope);
    this.#database
      .prepare(
        `INSERT INTO relay_session_event_outbox (
           event_id, session_id, envelope_json
         ) VALUES (?, ?, ?)`,
      )
      .run(envelope.eventId, envelope.sessionId, encoded);
    return encoded;
  };

  readonly pending = (): readonly string[] =>
    this.#database
      .prepare(
        `SELECT envelope_json
         FROM relay_session_event_outbox
         ORDER BY ordinal`,
      )
      .all()
      .map(readPendingEnvelope);
}
