import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { RuntimeDelivery } from "@moxt-ai/mobius-protocol";

const DEFAULT_OPERATION_LIMITS: DaemonOperationStateLimits = {
    runtimeDeliveryBytes: 32 * 1024 * 1024,
    runtimeDeliveryCount: 64,
};
const MAX_TERMINAL_RECEIPTS = 1_024;

export interface DaemonOperationStateLimits {
    readonly runtimeDeliveryBytes: number;
    readonly runtimeDeliveryCount: number;
}

export class RuntimeDeliveryInboxCapacityError extends Error {
    readonly code = "runtime_delivery_inbox_full";

    constructor() {
        super("The in-memory Runtime delivery inbox is full");
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

export class DaemonOperationState {
    readonly #database: DatabaseSync;
    readonly #limits: DaemonOperationStateLimits;

    constructor(limits: DaemonOperationStateLimits = DEFAULT_OPERATION_LIMITS) {
        validateLimits(limits);
        this.#limits = limits;
        this.#database = new DatabaseSync(":memory:");
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS daemon_turn_receipts (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('dispatching', 'running', 'succeeded', 'failed', 'cancelled')
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS daemon_runtime_deliveries (
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
    }

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): DaemonExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.#database
                .prepare(
                    `SELECT session_id, command_hash, attempt_id, state
           FROM daemon_turn_receipts WHERE command_id = ?`,
                )
                .get(commandId);
            if (typeof existing === "object" && existing !== null) {
                const storedSessionId = Reflect.get(existing, "session_id");
                const storedCommandHash = Reflect.get(existing, "command_hash");
                const attemptId = Reflect.get(existing, "attempt_id");
                const state = Reflect.get(existing, "state");
                if (
                    storedSessionId !== sessionId ||
                    storedCommandHash !== commandHash ||
                    typeof attemptId !== "string" ||
                    !isDaemonExecutionState(state)
                ) {
                    throw new Error("The daemon command identity conflicts with its in-memory receipt");
                }
                this.#database.exec("COMMIT");
                return { attemptId, commandId, kind: "duplicate", state };
            }
            const attemptId = crypto.randomUUID();
            this.#database
                .prepare(
                    `INSERT INTO daemon_turn_receipts (
             command_id, session_id, command_hash, attempt_id, state
           ) VALUES (?, ?, ?, ?, 'dispatching')`,
                )
                .run(commandId, sessionId, commandHash, attemptId);
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
        const row = this.#database
            .prepare(`SELECT state FROM daemon_turn_receipts WHERE command_id = ?`)
            .get(commandId);
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
        this.#database.prepare(`UPDATE daemon_turn_receipts SET state = ? WHERE command_id = ?`).run(state, commandId);
        if (state === "succeeded" || state === "failed" || state === "cancelled") {
            this.#database
                .prepare(
                    `DELETE FROM daemon_turn_receipts
                     WHERE state IN ('succeeded', 'failed', 'cancelled')
                     AND rowid NOT IN (
                       SELECT rowid FROM daemon_turn_receipts
                       WHERE state IN ('succeeded', 'failed', 'cancelled')
                       ORDER BY rowid DESC LIMIT ?
                     )`,
                )
                .run(MAX_TERMINAL_RECEIPTS);
        }
    };

    /**
     * The Attempt this live Runtime claimed for a command that has not reached a terminal state.
     * Receipts disappear when the daemon process exits.
     */
    readonly findUnsettledAttemptId = (commandId: string, sessionId: string): string | null => {
        const row = this.#database
            .prepare(`SELECT attempt_id, state FROM daemon_turn_receipts WHERE command_id = ? AND session_id = ?`)
            .get(commandId, sessionId);
        if (typeof row !== "object" || row === null) {
            return null;
        }
        const attemptId = Reflect.get(row, "attempt_id");
        const state = Reflect.get(row, "state");
        if (typeof attemptId !== "string" || attemptId.length === 0 || !isDaemonExecutionState(state)) {
            return null;
        }
        return state === "dispatching" || state === "running" ? attemptId : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const row = this.#database
            .prepare(`SELECT state FROM daemon_turn_receipts WHERE command_id = ? AND session_id = ?`)
            .get(commandId, sessionId);
        const state = typeof row === "object" && row !== null ? Reflect.get(row, "state") : undefined;
        return state === "succeeded" || state === "failed" || state === "cancelled";
    };

    readonly close = (): void => {
        this.#database.close();
    };

    readonly claimRuntimeDelivery = (delivery: RuntimeDelivery): StoredRuntimeDelivery => {
        const payloadBytes = new TextEncoder().encode(delivery.payload).byteLength;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.#database
                .prepare(
                    `SELECT session_id, payload_json, state
                     FROM daemon_runtime_deliveries
                     WHERE delivery_id = ?`,
                )
                .get(delivery.deliveryId);
            if (existing !== undefined) {
                const sessionId = rowString(existing, "session_id");
                const payload = rowString(existing, "payload_json");
                const state = runtimeDeliveryState(existing);
                if (sessionId !== delivery.sessionId || payload !== delivery.payload) {
                    throw new Error("The Runtime delivery identity conflicts with its in-memory receipt");
                }
                this.#database.exec("COMMIT");
                return new StoredRuntimeDelivery(delivery.deliveryId, sessionId, payload, state, true);
            }
            const usage = this.#database
                .prepare(
                    `SELECT COUNT(*) AS delivery_count,
                            COALESCE(SUM(payload_bytes), 0) AS delivery_bytes
                     FROM daemon_runtime_deliveries`,
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
                    `INSERT INTO daemon_runtime_deliveries (
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
                    `SELECT state FROM daemon_runtime_deliveries
                     WHERE delivery_id = ? AND session_id = ?`,
                )
                .get(deliveryId, sessionId);
            if (row === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const state = runtimeDeliveryState(row);
            if (state === "processed") {
                this.#database.prepare(`DELETE FROM daemon_runtime_deliveries WHERE delivery_id = ?`).run(deliveryId);
            } else if (state === "received") {
                this.#database
                    .prepare(`UPDATE daemon_runtime_deliveries SET state = 'relay_committed' WHERE delivery_id = ?`)
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
                    `SELECT state FROM daemon_runtime_deliveries
                     WHERE delivery_id = ? AND session_id = ?`,
                )
                .get(deliveryId, sessionId);
            if (row === undefined) {
                this.#database.exec("COMMIT");
                return false;
            }
            const state = runtimeDeliveryState(row);
            if (state === "relay_committed") {
                this.#database.prepare(`DELETE FROM daemon_runtime_deliveries WHERE delivery_id = ?`).run(deliveryId);
            } else if (state === "received") {
                this.#database
                    .prepare(`UPDATE daemon_runtime_deliveries SET state = 'processed' WHERE delivery_id = ?`)
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
                 FROM daemon_runtime_deliveries
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
}

function validateLimits(limits: DaemonOperationStateLimits): void {
    if (
        !Number.isSafeInteger(limits.runtimeDeliveryBytes) ||
        limits.runtimeDeliveryBytes < 1 ||
        !Number.isSafeInteger(limits.runtimeDeliveryCount) ||
        limits.runtimeDeliveryCount < 1
    ) {
        throw new Error("Runtime delivery inbox limits must be positive integers");
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
