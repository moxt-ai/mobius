import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    decodeSessionEventEnvelope,
    encodeSessionEventEnvelope,
    type ReliableSessionEventEnvelope,
    SESSION_EVENT_KIND,
    type SessionEventAcknowledgement,
    type SessionEventRejected,
} from "@moxt-ai/mobius-protocol";

const DEFAULT_STANDARD_EVENT_BYTES = 96 * 1024 * 1024;
const DEFAULT_CRITICAL_EVENT_BYTES = 128 * 1024 * 1024;
const MAX_DEAD_LETTERS = 1_024;

export interface SessionEventOutboxLimits {
    readonly criticalEventBytes: number;
    readonly standardEventBytes: number;
}

const DEFAULT_LIMITS: SessionEventOutboxLimits = {
    criticalEventBytes: DEFAULT_CRITICAL_EVENT_BYTES,
    standardEventBytes: DEFAULT_STANDARD_EVENT_BYTES,
};

export class SessionEventOutboxCapacityError extends Error {
    readonly code = "session_event_outbox_full";

    constructor() {
        super("The persistent Session event outbox is full");
        this.name = "SessionEventOutboxCapacityError";
    }
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

function validateLimits(limits: SessionEventOutboxLimits): void {
    if (
        !Number.isSafeInteger(limits.standardEventBytes) ||
        limits.standardEventBytes < 1 ||
        !Number.isSafeInteger(limits.criticalEventBytes) ||
        limits.criticalEventBytes < limits.standardEventBytes
    ) {
        throw new Error("Session event outbox limits are invalid");
    }
}

export class SessionEventOutbox {
    readonly #database: DatabaseSync;
    readonly #limits: SessionEventOutboxLimits;

    constructor(path: string, limits: SessionEventOutboxLimits = DEFAULT_LIMITS) {
        validateLimits(limits);
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        this.#limits = limits;
        this.#database = new DatabaseSync(path);
        this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS relay_session_event_outbox (
                ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                source_seq INTEGER NOT NULL UNIQUE,
                byte_length INTEGER NOT NULL,
                envelope_json TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS relay_session_event_outbox_order
                ON relay_session_event_outbox(source_seq);
            CREATE TABLE IF NOT EXISTS relay_session_event_outbox_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                stream_id TEXT NOT NULL,
                next_source_seq INTEGER NOT NULL,
                total_bytes INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS relay_session_event_dead_letters (
                ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                rejection_code TEXT NOT NULL,
                envelope_json TEXT NOT NULL
            ) STRICT;
        `);
        this.#database
            .prepare(
                `INSERT OR IGNORE INTO relay_session_event_outbox_state (
                    singleton, stream_id, next_source_seq, total_bytes
                ) VALUES (1, ?, 1, 0)`,
            )
            .run(randomUUID());
    }

    readonly acknowledge = (acknowledgement: SessionEventAcknowledgement): boolean =>
        this.#remove(acknowledgement.eventId, acknowledgement.sessionId);

    readonly close = (): void => {
        this.#database.close();
    };

    readonly enqueue = (sessionId: string, payload: string, critical: boolean): ReliableSessionEventEnvelope => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const state = this.#database
                .prepare(
                    `SELECT stream_id, next_source_seq, total_bytes
                     FROM relay_session_event_outbox_state
                     WHERE singleton = 1`,
                )
                .get();
            const sourceSeq = rowNumber(state, "next_source_seq");
            if (sourceSeq < 1 || !Number.isSafeInteger(sourceSeq + 1)) {
                throw new Error("The Session event source sequence is exhausted");
            }
            const envelope: ReliableSessionEventEnvelope = {
                delivery: {
                    eventId: randomUUID(),
                    kind: "reliable",
                    sourceSeq: sourceSeq.toString(),
                    streamId: rowString(state, "stream_id"),
                },
                kind: SESSION_EVENT_KIND,
                payload,
                sessionId,
            };
            const encoded = encodeSessionEventEnvelope(envelope);
            const byteLength = Buffer.byteLength(encoded, "utf8");
            const maximumBytes = critical ? this.#limits.criticalEventBytes : this.#limits.standardEventBytes;
            if (rowNumber(state, "total_bytes") + byteLength > maximumBytes) {
                throw new SessionEventOutboxCapacityError();
            }
            this.#database
                .prepare(
                    `INSERT INTO relay_session_event_outbox (
                        event_id, session_id, source_seq, byte_length, envelope_json
                    ) VALUES (?, ?, ?, ?, ?)`,
                )
                .run(envelope.delivery.eventId, sessionId, sourceSeq, byteLength, encoded);
            this.#database
                .prepare(
                    `UPDATE relay_session_event_outbox_state
                     SET next_source_seq = next_source_seq + 1,
                         total_bytes = total_bytes + ?
                     WHERE singleton = 1`,
                )
                .run(byteLength);
            this.#database.exec("COMMIT");
            return envelope;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly pending = (
        limit: number,
        excludedEventIds: readonly string[],
    ): readonly ReliableSessionEventEnvelope[] => {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Session event replay limit must be a positive integer");
        }
        const exclusion =
            excludedEventIds.length === 0
                ? ""
                : `WHERE event_id NOT IN (${excludedEventIds.map(() => "?").join(", ")})`;
        return this.#database
            .prepare(
                `SELECT envelope_json
                 FROM relay_session_event_outbox
                 ${exclusion}
                 ORDER BY source_seq
                 LIMIT ?`,
            )
            .all(...excludedEventIds, limit)
            .map((row) => {
                const envelope = decodeSessionEventEnvelope(rowString(row, "envelope_json"));
                if (!("delivery" in envelope)) {
                    throw new Error("SQLite returned an invalid reliable Session event envelope");
                }
                return envelope;
            });
    };

    readonly quarantine = (rejection: SessionEventRejected): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const stored = this.#database
                .prepare(
                    `SELECT byte_length, envelope_json
                     FROM relay_session_event_outbox
                     WHERE event_id = ? AND session_id = ?`,
                )
                .get(rejection.eventId, rejection.sessionId);
            if (stored === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            this.#database
                .prepare(
                    `INSERT INTO relay_session_event_dead_letters (
                        event_id, session_id, rejection_code, envelope_json
                    ) VALUES (?, ?, ?, ?)`,
                )
                .run(rejection.eventId, rejection.sessionId, rejection.code, rowString(stored, "envelope_json"));
            this.#deleteStored(rejection.eventId, rejection.sessionId, rowNumber(stored, "byte_length"));
            this.#database
                .prepare(
                    `DELETE FROM relay_session_event_dead_letters
                     WHERE ordinal NOT IN (
                         SELECT ordinal FROM relay_session_event_dead_letters
                         ORDER BY ordinal DESC LIMIT ?
                     )`,
                )
                .run(MAX_DEAD_LETTERS);
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };

    readonly #deleteStored = (eventId: string, sessionId: string, byteLength: number): void => {
        const deletion = this.#database
            .prepare(
                `DELETE FROM relay_session_event_outbox
                 WHERE event_id = ? AND session_id = ?`,
            )
            .run(eventId, sessionId);
        if (deletion.changes !== 1) {
            throw new Error("The Session event could not be removed from the outbox");
        }
        const state = this.#database
            .prepare(
                `UPDATE relay_session_event_outbox_state
                 SET total_bytes = total_bytes - ?
                 WHERE singleton = 1 AND total_bytes >= ?`,
            )
            .run(byteLength, byteLength);
        if (state.changes !== 1) {
            throw new Error("The Session event outbox capacity state is inconsistent");
        }
    };

    readonly #remove = (eventId: string, sessionId: string): boolean => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const stored = this.#database
                .prepare(
                    `SELECT byte_length
                     FROM relay_session_event_outbox
                     WHERE event_id = ? AND session_id = ?`,
                )
                .get(eventId, sessionId);
            if (stored === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            this.#deleteStored(eventId, sessionId, rowNumber(stored, "byte_length"));
            this.#database.exec("COMMIT");
            return true;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };
}
