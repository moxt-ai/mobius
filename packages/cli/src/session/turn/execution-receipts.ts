import { createHash, randomUUID } from "node:crypto";

const MAX_TERMINAL_RECEIPTS = 1_024;

export type RuntimeExecutionState = "cancelled" | "dispatching" | "failed" | "running" | "succeeded";

export type RuntimeExecutionReceipt =
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "accepted" | "duplicate";
          state: RuntimeExecutionState;
      }>
    | { readonly kind: "conflict" };

type StoredExecution = Readonly<{
    attemptId: string;
    commandHash: string;
    sessionId: string;
    state: RuntimeExecutionState;
}>;

function isTerminal(state: RuntimeExecutionState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class ExecutionReceipts {
    readonly #executions = new Map<string, StoredExecution>();
    readonly #terminalCountBySession = new Map<string, number>();

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): RuntimeExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        const existing = this.#executions.get(commandId);
        if (existing !== undefined) {
            if (existing.sessionId !== sessionId || existing.commandHash !== commandHash) {
                return { kind: "conflict" };
            }
            return { attemptId: existing.attemptId, commandId, kind: "duplicate", state: existing.state };
        }
        const attemptId = randomUUID();
        this.#executions.set(commandId, { attemptId, commandHash, sessionId, state: "dispatching" });
        return { attemptId, commandId, kind: "accepted", state: "dispatching" };
    };

    readonly transitionExecution = (commandId: string, state: RuntimeExecutionState): void => {
        const current = this.#executions.get(commandId);
        if (current === undefined) {
            throw new Error("The runtime execution receipt does not exist");
        }
        if (current.state === state) {
            return;
        }
        const allowed =
            (current.state === "dispatching" && (state === "running" || state === "failed" || state === "cancelled")) ||
            (current.state === "running" && isTerminal(state));
        if (!allowed) {
            throw new Error("The runtime execution transition is invalid");
        }
        this.#executions.set(commandId, { ...current, state });
        if (isTerminal(state)) {
            // Retention is per Session: one Session's terminal volume must not
            // evict another Session's receipts and break its queue targets.
            this.#terminalCountBySession.set(
                current.sessionId,
                (this.#terminalCountBySession.get(current.sessionId) ?? 0) + 1,
            );
            this.pruneTerminalReceipts(current.sessionId);
        }
    };

    /** Receipts disappear when the runtime process exits. */
    readonly findUnsettledAttemptId = (commandId: string, sessionId: string): string | null => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && !isTerminal(receipt.state) ? receipt.attemptId : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && isTerminal(receipt.state);
    };

    readonly close = (): void => {
        this.#executions.clear();
        this.#terminalCountBySession.clear();
    };

    private readonly pruneTerminalReceipts = (sessionId: string): void => {
        if ((this.#terminalCountBySession.get(sessionId) ?? 0) <= MAX_TERMINAL_RECEIPTS) {
            return;
        }
        for (const [commandId, receipt] of this.#executions) {
            if (receipt.sessionId === sessionId && isTerminal(receipt.state)) {
                this.#executions.delete(commandId);
                const remaining = (this.#terminalCountBySession.get(sessionId) ?? 1) - 1;
                if (remaining > 0) {
                    this.#terminalCountBySession.set(sessionId, remaining);
                } else {
                    this.#terminalCountBySession.delete(sessionId);
                }
                if ((this.#terminalCountBySession.get(sessionId) ?? 0) <= MAX_TERMINAL_RECEIPTS) {
                    return;
                }
            }
        }
    };
}
