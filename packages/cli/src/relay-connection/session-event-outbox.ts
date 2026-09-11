import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    encodeSessionEventEnvelope,
    type RuntimeDelivery,
    SESSION_EVENT_KIND,
    type SessionEventAcknowledgement,
    type SessionEventEnvelope,
    type SessionEventRejection,
} from "@moxt-ai/mobius-protocol";

const DEFAULT_OUTBOX_LIMITS: SessionEventOutboxLimits = {
    criticalEventBytes: 136 * 1024 * 1024,
    criticalEventCount: 10_128,
    runtimeDeliveryBytes: 64 * 1024 * 1024,
    runtimeDeliveryCount: 64,
    standardEventBytes: 128 * 1024 * 1024,
    standardEventCount: 10_000,
};

export interface SessionEventOutboxLimits {
    readonly criticalEventBytes: number;
    readonly criticalEventCount: number;
    readonly runtimeDeliveryBytes: number;
    readonly runtimeDeliveryCount: number;
    readonly standardEventBytes: number;
    readonly standardEventCount: number;
}

export class SessionEventOutboxCapacityError extends Error {
    readonly code = "session_event_outbox_full";

    constructor() {
        super("The durable Session event outbox is full");
        this.name = "SessionEventOutboxCapacityError";
    }
}

export class RuntimeDeliveryInboxCapacityError extends Error {
    readonly code = "runtime_delivery_inbox_full";

    constructor() {
        super("The durable Runtime delivery inbox is full");
        this.name = "RuntimeDeliveryInboxCapacityError";
    }
}

export class StoredRuntimeDelivery {
    readonly deliveryId: string;
    readonly duplicate: boolean;
    readonly payload: string;
    readonly sessionId: string;
    readonly state: string;

    constructor(deliveryId: string, sessionId: string, payload: string, state: string, duplicate: boolean) {
        this.deliveryId = deliveryId;
        this.duplicate = duplicate;
        this.payload = payload;
        this.sessionId = sessionId;
        this.state = state;
    }
}

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

function rowNumber(row: unknown, field: string): number {
    const value = typeof row === "object" && row !== null ? Reflect.get(row, field) : undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`SQLite returned an invalid ${field} value`);
    }
    return value;
}

function rowString(row: unknown, field: string): string {
    const value = typeof row === "object" && row !== null ? Reflect.get(row, field) : undefined;
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`SQLite returned an invalid ${field} value`);
    }
    return value;
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
    readonly #limits: SessionEventOutboxLimits;

    constructor(path: string, limits: SessionEventOutboxLimits = DEFAULT_OUTBOX_LIMITS) {
        validateLimits(limits);
        this.#limits = limits;
        mkdirSync(dirname(path), { recursive: true });
        this.#database = new DatabaseSync(path);
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS relay_session_event_outbox (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
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
          rejection_code IN ('session_deleted', 'session_not_found', 'session_rejected')
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
      CREATE TABLE IF NOT EXISTS relay_session_event_outbox_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        event_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO relay_session_event_outbox_state (
        singleton, event_count, total_bytes
      ) VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS relay_runtime_deliveries (
        delivery_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('received', 'relay_committed', 'processed')
        ),
        received_at INTEGER NOT NULL
      ) STRICT;
    `);
        const deadLetterTable = this.#database
            .prepare(
                `SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'relay_session_event_dead_letters'`,
            )
            .get();
        const deadLetterSql =
            typeof deadLetterTable === "object" && deadLetterTable !== null
                ? Reflect.get(deadLetterTable, "sql")
                : undefined;
        if (typeof deadLetterSql !== "string" || !deadLetterSql.includes("'session_rejected'")) {
            this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE relay_session_event_dead_letters
          RENAME TO relay_session_event_dead_letters_legacy;
        CREATE TABLE relay_session_event_dead_letters (
          ordinal INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          rejection_code TEXT NOT NULL CHECK (
            rejection_code IN ('session_deleted', 'session_not_found', 'session_rejected')
          )
        ) STRICT;
        INSERT INTO relay_session_event_dead_letters (
          ordinal, event_id, session_id, envelope_json, rejection_code
        )
        SELECT ordinal, event_id, session_id, envelope_json, rejection_code
        FROM relay_session_event_dead_letters_legacy;
        DROP TABLE relay_session_event_dead_letters_legacy;
        COMMIT;
      `);
        }
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
        const hasByteLength = outboxColumns.some(
            (column) => typeof column === "object" && column !== null && Reflect.get(column, "name") === "byte_length",
        );
        if (!hasByteLength) {
            this.#database.exec(`
        ALTER TABLE relay_session_event_outbox
          ADD COLUMN byte_length INTEGER NOT NULL DEFAULT 0;
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
      UPDATE relay_session_event_outbox
      SET byte_length = length(CAST(envelope_json AS BLOB))
      WHERE byte_length = 0;
      UPDATE relay_session_event_outbox_state
      SET event_count = (SELECT COUNT(*) FROM relay_session_event_outbox),
          total_bytes = (
            SELECT COALESCE(SUM(byte_length), 0)
            FROM relay_session_event_outbox
          )
      WHERE singleton = 1;
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
        this.#removeAcknowledgedEvent(acknowledgement.eventId, acknowledgement.sessionId);

    readonly quarantine = (rejection: SessionEventRejection): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const stored = this.#database
                .prepare(
                    `SELECT byte_length FROM relay_session_event_outbox
                     WHERE event_id = ? AND session_id = ?`,
                )
                .get(rejection.eventId, rejection.sessionId);
            if (stored === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const byteLength = rowNumber(stored, "byte_length");
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
            this.#decrementEventState(byteLength);
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
        return this.#enqueueBounded(
            sessionId,
            payload,
            attemptId ?? "",
            this.#limits.standardEventCount,
            this.#limits.standardEventBytes,
        );
    };

    readonly enqueueCritical = (sessionId: string, payload: string, attemptId = ""): string =>
        this.#enqueueBounded(
            sessionId,
            payload,
            attemptId,
            this.#limits.criticalEventCount,
            this.#limits.criticalEventBytes,
        );

    readonly claimRuntimeDelivery = (delivery: RuntimeDelivery): StoredRuntimeDelivery => {
        const payloadBytes = new TextEncoder().encode(delivery.payload).byteLength;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.#database
                .prepare(
                    `SELECT session_id, payload_json, state
                     FROM relay_runtime_deliveries
                     WHERE delivery_id = ?`,
                )
                .get(delivery.deliveryId);
            if (existing !== undefined) {
                const sessionId = rowString(existing, "session_id");
                const payload = rowString(existing, "payload_json");
                const state = runtimeDeliveryState(existing);
                if (sessionId !== delivery.sessionId || payload !== delivery.payload) {
                    throw new Error("The Runtime delivery identity conflicts with its durable receipt");
                }
                this.#database.exec("COMMIT");
                return new StoredRuntimeDelivery(delivery.deliveryId, sessionId, payload, state, true);
            }
            const usage = this.#database
                .prepare(
                    `SELECT COUNT(*) AS delivery_count,
                            COALESCE(SUM(payload_bytes), 0) AS delivery_bytes
                     FROM relay_runtime_deliveries`,
                )
                .get();
            if (
                rowNumber(usage, "delivery_count") + 1 > this.#limits.runtimeDeliveryCount ||
                rowNumber(usage, "delivery_bytes") + payloadBytes > this.#limits.runtimeDeliveryBytes
            ) {
                throw new RuntimeDeliveryInboxCapacityError();
            }
            this.#database
                .prepare(
                    `INSERT INTO relay_runtime_deliveries (
                       delivery_id, session_id, payload_json, payload_bytes, state, received_at
                     ) VALUES (?, ?, ?, ?, 'received', ?)`,
                )
                .run(delivery.deliveryId, delivery.sessionId, delivery.payload, payloadBytes, Date.now());
            this.#database.exec("COMMIT");
            return new StoredRuntimeDelivery(
                delivery.deliveryId,
                delivery.sessionId,
                delivery.payload,
                "received",
                false,
            );
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly markRuntimeDeliveryCommitted = (deliveryId: string, sessionId: string): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#database
                .prepare(
                    `SELECT state FROM relay_runtime_deliveries
                     WHERE delivery_id = ? AND session_id = ?`,
                )
                .get(deliveryId, sessionId);
            if (row === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const state = runtimeDeliveryState(row);
            if (state === "processed") {
                this.#database.prepare(`DELETE FROM relay_runtime_deliveries WHERE delivery_id = ?`).run(deliveryId);
            } else if (state === "received") {
                this.#database
                    .prepare(`UPDATE relay_runtime_deliveries SET state = 'relay_committed' WHERE delivery_id = ?`)
                    .run(deliveryId);
            }
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly markRuntimeDeliveryProcessed = (deliveryId: string, sessionId: string): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#database
                .prepare(
                    `SELECT state FROM relay_runtime_deliveries
                     WHERE delivery_id = ? AND session_id = ?`,
                )
                .get(deliveryId, sessionId);
            if (row === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const state = runtimeDeliveryState(row);
            if (state === "relay_committed") {
                this.#database.prepare(`DELETE FROM relay_runtime_deliveries WHERE delivery_id = ?`).run(deliveryId);
            } else if (state === "received") {
                this.#database
                    .prepare(`UPDATE relay_runtime_deliveries SET state = 'processed' WHERE delivery_id = ?`)
                    .run(deliveryId);
            }
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly runtimeDeliveries = (): readonly StoredRuntimeDelivery[] =>
        this.#database
            .prepare(
                `SELECT delivery_id, session_id, payload_json, state
                 FROM relay_runtime_deliveries
                 ORDER BY received_at, delivery_id`,
            )
            .all()
            .map(
                (row) =>
                    new StoredRuntimeDelivery(
                        rowString(row, "delivery_id"),
                        rowString(row, "session_id"),
                        rowString(row, "payload_json"),
                        runtimeDeliveryState(row),
                        true,
                    ),
            );

    readonly #enqueueBounded = (
        sessionId: string,
        payload: string,
        attemptId: string,
        maximumEventCount: number,
        maximumEventBytes: number,
    ): string => {
        const sourceKey = attemptId.length === 0 ? `runtime:${sessionId}` : `attempt:${sessionId}:${attemptId}`;
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
                    attemptId.length === 0
                        ? { kind: "runtime", sourceSeq: nextSourceSeq.toString() }
                        : {
                              attemptId,
                              kind: "attempt",
                              sourceSeq: nextSourceSeq.toString(),
                          },
            };
            const encoded = encodeSessionEventEnvelope(envelope);
            const byteLength = new TextEncoder().encode(encoded).byteLength;
            const state = this.#database
                .prepare(
                    `SELECT event_count, total_bytes
                     FROM relay_session_event_outbox_state
                     WHERE singleton = 1`,
                )
                .get();
            if (
                rowNumber(state, "event_count") + 1 > maximumEventCount ||
                rowNumber(state, "total_bytes") + byteLength > maximumEventBytes
            ) {
                throw new SessionEventOutboxCapacityError();
            }
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
             event_id, session_id, source_key, byte_length, envelope_json
           ) VALUES (?, ?, ?, ?, ?)`,
                )
                .run(envelope.eventId, envelope.sessionId, sourceKey, byteLength, encoded);
            this.#database
                .prepare(
                    `UPDATE relay_session_event_outbox_state
                     SET event_count = event_count + 1,
                         total_bytes = total_bytes + ?
                     WHERE singleton = 1`,
                )
                .run(byteLength);
            this.#database.exec("COMMIT");
            return encoded;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly #removeAcknowledgedEvent = (eventId: string, sessionId: string): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const stored = this.#database
                .prepare(
                    `SELECT byte_length FROM relay_session_event_outbox
                     WHERE event_id = ? AND session_id = ?`,
                )
                .get(eventId, sessionId);
            if (stored === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const byteLength = rowNumber(stored, "byte_length");
            const deletion = this.#database
                .prepare(
                    `DELETE FROM relay_session_event_outbox
                     WHERE event_id = ? AND session_id = ?`,
                )
                .run(eventId, sessionId);
            if (deletion.changes !== 1) {
                throw new Error("The acknowledged session event could not be removed from the durable outbox");
            }
            this.#decrementEventState(byteLength);
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly #decrementEventState = (byteLength: number): void => {
        const result = this.#database
            .prepare(
                `UPDATE relay_session_event_outbox_state
                 SET event_count = event_count - 1,
                     total_bytes = total_bytes - ?
                 WHERE singleton = 1 AND event_count > 0 AND total_bytes >= ?`,
            )
            .run(byteLength, byteLength);
        if (result.changes !== 1) {
            throw new Error("The Session event outbox capacity state is inconsistent");
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

    readonly pendingSourceHeads = (
        limit: number,
        excludedEventIds: readonly string[],
        excludedSourceKeys: readonly string[],
    ): readonly string[] => {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Session event replay batch limit must be a positive integer");
        }
        const exclusions: string[] = [];
        const parameters: string[] = [];
        if (excludedEventIds.length > 0) {
            exclusions.push(`event_id NOT IN (${excludedEventIds.map(() => "?").join(", ")})`);
            parameters.push(...excludedEventIds);
        }
        if (excludedSourceKeys.length > 0) {
            exclusions.push(`source_key NOT IN (${excludedSourceKeys.map(() => "?").join(", ")})`);
            parameters.push(...excludedSourceKeys);
        }
        parameters.push(limit.toString());
        const where = exclusions.length === 0 ? "" : `WHERE ${exclusions.join(" AND ")}`;
        return this.#database
            .prepare(
                `WITH available_events AS (
                   SELECT ordinal, source_key
                   FROM relay_session_event_outbox
                   ${where}
                 ), ranked_events AS (
                   SELECT ordinal,
                          ROW_NUMBER() OVER (
                            PARTITION BY source_key
                            ORDER BY ordinal
                          ) AS source_position
                   FROM available_events
                 )
                 SELECT outbox.envelope_json
                 FROM ranked_events AS ranked
                 INNER JOIN relay_session_event_outbox AS outbox
                   ON outbox.ordinal = ranked.ordinal
                 WHERE ranked.source_position = 1
                 ORDER BY outbox.ordinal
                 LIMIT ?`,
            )
            .all(...parameters)
            .map(readPendingEnvelope);
    };
}

function validateLimits(limits: SessionEventOutboxLimits): void {
    const values = [
        limits.criticalEventBytes,
        limits.criticalEventCount,
        limits.runtimeDeliveryBytes,
        limits.runtimeDeliveryCount,
        limits.standardEventBytes,
        limits.standardEventCount,
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
        throw new Error("Session event outbox limits must be positive integers");
    }
    if (
        limits.criticalEventBytes < limits.standardEventBytes ||
        limits.criticalEventCount < limits.standardEventCount
    ) {
        throw new Error("Critical Session event capacity must include the standard capacity");
    }
}

function runtimeDeliveryState(row: unknown): string {
    const state = rowString(row, "state");
    if (state !== "received" && state !== "relay_committed" && state !== "processed") {
        throw new Error("SQLite returned an invalid Runtime delivery state");
    }
    return state;
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
