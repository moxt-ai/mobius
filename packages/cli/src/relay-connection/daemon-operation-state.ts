import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const MAX_TERMINAL_RECEIPTS = 1_024;

export type DaemonExecutionState = "cancelled" | "dispatching" | "failed" | "running" | "succeeded";

export type DaemonExecutionReceipt = Readonly<{
    attemptId: string;
    commandId: string;
    kind: "accepted" | "duplicate";
    state: DaemonExecutionState;
}>;

export class DaemonOperationState {
    readonly #database: DatabaseSync;

    constructor() {
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
