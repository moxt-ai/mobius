import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    encodeSessionEventEnvelope,
    SESSION_EVENT_KIND,
    type SessionEventAcknowledgement,
    type SessionEventEnvelope,
    type SessionEventRejection,
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

export type DaemonExecutionState = "cancelled" | "dispatching" | "failed" | "running" | "succeeded";

export type DaemonExecutionReceipt = Readonly<{
    attemptId: string;
    commandId: string;
    kind: "accepted" | "duplicate";
    state: DaemonExecutionState;
}>;

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
        source_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relay_session_event_outbox_order
        ON relay_session_event_outbox(ordinal);
      CREATE TABLE IF NOT EXISTS relay_session_event_dead_letters (
        ordinal INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        rejection_code TEXT NOT NULL CHECK (
          rejection_code IN ('session_deleted', 'session_not_found')
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_session_event_sources (
        source_key TEXT PRIMARY KEY,
        next_source_seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_turn_receipts (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('dispatching', 'running', 'succeeded', 'failed', 'cancelled')
        )
      ) STRICT;
    `);
        const outboxColumns = this.#database.prepare("PRAGMA table_info(relay_session_event_outbox)").all();
        const hasSourceKey = outboxColumns.some(
            (column) => typeof column === "object" && column !== null && Reflect.get(column, "name") === "source_key",
        );
        if (!hasSourceKey) {
            this.#database.exec(`
        ALTER TABLE relay_session_event_outbox
          ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
      `);
        }
        this.#database.exec(`
      UPDATE relay_session_event_outbox
      SET source_key = CASE json_extract(envelope_json, '$.source.kind')
        WHEN 'attempt' THEN
          'attempt:' || session_id || ':' || json_extract(envelope_json, '$.source.attemptId')
        ELSE 'runtime:' || session_id
      END
      WHERE source_key = '';
      CREATE INDEX IF NOT EXISTS relay_session_event_outbox_source_order
        ON relay_session_event_outbox(source_key, ordinal);
    `);
    }

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): DaemonExecutionReceipt => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.#database
                .prepare(
                    `SELECT session_id, command_json, attempt_id, state
           FROM relay_turn_receipts WHERE command_id = ?`,
                )
                .get(commandId);
            if (typeof existing === "object" && existing !== null) {
                const storedSessionId = Reflect.get(existing, "session_id");
                const storedCommand = Reflect.get(existing, "command_json");
                const attemptId = Reflect.get(existing, "attempt_id");
                const state = Reflect.get(existing, "state");
                if (
                    storedSessionId !== sessionId ||
                    storedCommand !== commandJson ||
                    typeof attemptId !== "string" ||
                    !isDaemonExecutionState(state)
                ) {
                    throw new Error("The daemon command identity conflicts with its durable receipt");
                }
                this.#database.exec("COMMIT");
                return { attemptId, commandId, kind: "duplicate", state };
            }
            const attemptId = crypto.randomUUID();
            this.#database
                .prepare(
                    `INSERT INTO relay_turn_receipts (
             command_id, session_id, command_json, attempt_id, state
           ) VALUES (?, ?, ?, ?, 'dispatching')`,
                )
                .run(commandId, sessionId, commandJson, attemptId);
            this.#database.exec("COMMIT");
            return {
                attemptId,
                commandId,
                kind: "accepted",
                state: "dispatching",
            };
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly transitionExecution = (commandId: string, state: DaemonExecutionState): void => {
        const row = this.#database.prepare(`SELECT state FROM relay_turn_receipts WHERE command_id = ?`).get(commandId);
        const current = typeof row === "object" && row !== null ? Reflect.get(row, "state") : undefined;
        if (!isDaemonExecutionState(current)) {
            throw new Error("The daemon execution receipt does not exist");
        }
        if (current === state) {
            return;
        }
        const allowed =
            (current === "dispatching" && (state === "running" || state === "failed" || state === "cancelled")) ||
            (current === "running" && (state === "succeeded" || state === "failed" || state === "cancelled"));
        if (!allowed) {
            throw new Error("The daemon execution transition is invalid");
        }
        this.#database.prepare(`UPDATE relay_turn_receipts SET state = ? WHERE command_id = ?`).run(state, commandId);
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const row = this.#database
            .prepare(`SELECT state FROM relay_turn_receipts WHERE command_id = ? AND session_id = ?`)
            .get(commandId, sessionId);
        const state = typeof row === "object" && row !== null ? Reflect.get(row, "state") : undefined;
        return state === "succeeded" || state === "failed" || state === "cancelled";
    };

    readonly acknowledge = (acknowledgement: SessionEventAcknowledgement): boolean =>
        this.#database
            .prepare(
                `DELETE FROM relay_session_event_outbox
         WHERE event_id = ? AND session_id = ?`,
            )
            .run(acknowledgement.eventId, acknowledgement.sessionId).changes === 1;

    readonly quarantine = (rejection: SessionEventRejection): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const insertion = this.#database
                .prepare(
                    `INSERT INTO relay_session_event_dead_letters (
             ordinal, event_id, session_id, envelope_json, rejection_code
           )
           SELECT ordinal, event_id, session_id, envelope_json, ?
           FROM relay_session_event_outbox
           WHERE event_id = ? AND session_id = ?`,
                )
                .run(rejection.code, rejection.eventId, rejection.sessionId);
            if (insertion.changes !== 1) {
                this.#database.exec("COMMIT");
                return false;
            }
            const deletion = this.#database
                .prepare(
                    `DELETE FROM relay_session_event_outbox
           WHERE event_id = ? AND session_id = ?`,
                )
                .run(rejection.eventId, rejection.sessionId);
            if (deletion.changes !== 1) {
                throw new Error("The rejected session event could not be removed from the durable outbox");
            }
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly close = (): void => {
        this.#database.close();
    };

    readonly enqueue = (sessionId: string, payload: string, attemptId: string | null = null): string => {
        const sourceKey = attemptId === null ? `runtime:${sessionId}` : `attempt:${sessionId}:${attemptId}`;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#database
                .prepare(
                    `SELECT next_source_seq FROM relay_session_event_sources
           WHERE source_key = ?`,
                )
                .get(sourceKey);
            const storedSourceSeq =
                typeof row === "object" && row !== null ? Reflect.get(row, "next_source_seq") : undefined;
            const nextSourceSeq = typeof storedSourceSeq === "number" ? storedSourceSeq : 1;
            if (!Number.isSafeInteger(nextSourceSeq) || nextSourceSeq < 1) {
                throw new Error("SQLite returned an invalid event source sequence");
            }
            const envelope: SessionEventEnvelope = {
                eventId: crypto.randomUUID(),
                kind: SESSION_EVENT_KIND,
                payload,
                sessionId,
                source:
                    attemptId === null
                        ? { kind: "runtime", sourceSeq: nextSourceSeq.toString() }
                        : {
                              attemptId,
                              kind: "attempt",
                              sourceSeq: nextSourceSeq.toString(),
                          },
            };
            const encoded = encodeSessionEventEnvelope(envelope);
            this.#database
                .prepare(
                    `INSERT INTO relay_session_event_sources (
             source_key, next_source_seq
           ) VALUES (?, ?)
           ON CONFLICT(source_key) DO UPDATE SET
             next_source_seq = excluded.next_source_seq`,
                )
                .run(sourceKey, nextSourceSeq + 1);
            this.#database
                .prepare(
                    `INSERT INTO relay_session_event_outbox (
             event_id, session_id, source_key, envelope_json
           ) VALUES (?, ?, ?, ?)`,
                )
                .run(envelope.eventId, envelope.sessionId, sourceKey, encoded);
            this.#database.exec("COMMIT");
            return encoded;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
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

    readonly pendingBatch = (limit: number): readonly string[] => {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Session event replay batch limit must be a positive integer");
        }
        return this.#database
            .prepare(
                `WITH ranked_events AS (
                   SELECT ordinal,
                          ROW_NUMBER() OVER (
                            PARTITION BY source_key
                            ORDER BY ordinal
                          ) AS source_position
                   FROM relay_session_event_outbox
                 )
                 SELECT outbox.envelope_json
                 FROM ranked_events AS ranked
                 INNER JOIN relay_session_event_outbox AS outbox
                   ON outbox.ordinal = ranked.ordinal
                 ORDER BY ranked.source_position, outbox.ordinal
                 LIMIT ?`,
            )
            .all(limit)
            .map(readPendingEnvelope);
    };
}

function isDaemonExecutionState(value: unknown): value is DaemonExecutionState {
    return (
        value === "cancelled" ||
        value === "dispatching" ||
        value === "failed" ||
        value === "running" ||
        value === "succeeded"
    );
}
