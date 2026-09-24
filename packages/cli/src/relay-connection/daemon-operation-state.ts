import { createHash, randomUUID } from "node:crypto";

const MAX_TERMINAL_RECEIPTS = 1_024;

export type DaemonExecutionState = "cancelled" | "dispatching" | "failed" | "running" | "succeeded";

export type DaemonExecutionReceipt = Readonly<{
    attemptId: string;
    commandId: string;
    kind: "accepted" | "duplicate";
    state: DaemonExecutionState;
}>;

type StoredExecution = Readonly<{
    attemptId: string;
    commandHash: string;
    sessionId: string;
    state: DaemonExecutionState;
}>;

function isTerminal(state: DaemonExecutionState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class DaemonOperationState {
    readonly #executions = new Map<string, StoredExecution>();
    #terminalCount = 0;

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): DaemonExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        const existing = this.#executions.get(commandId);
        if (existing !== undefined) {
            if (existing.sessionId !== sessionId || existing.commandHash !== commandHash) {
                throw new Error("The daemon command identity conflicts with its in-memory receipt");
            }
            return { attemptId: existing.attemptId, commandId, kind: "duplicate", state: existing.state };
        }
        const attemptId = randomUUID();
        this.#executions.set(commandId, { attemptId, commandHash, sessionId, state: "dispatching" });
        return { attemptId, commandId, kind: "accepted", state: "dispatching" };
    };

    readonly transitionExecution = (commandId: string, state: DaemonExecutionState): void => {
        const current = this.#executions.get(commandId);
        if (current === undefined) {
            throw new Error("The daemon execution receipt does not exist");
        }
        if (current.state === state) {
            return;
        }
        const allowed =
            (current.state === "dispatching" && (state === "running" || state === "failed" || state === "cancelled")) ||
            (current.state === "running" && isTerminal(state));
        if (!allowed) {
            throw new Error("The daemon execution transition is invalid");
        }
        this.#executions.set(commandId, { ...current, state });
        if (isTerminal(state)) {
            this.#terminalCount += 1;
            this.pruneTerminalReceipts();
        }
    };

    /** Receipts disappear when the daemon process exits. */
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
        this.#terminalCount = 0;
    };

    private readonly pruneTerminalReceipts = (): void => {
        if (this.#terminalCount <= MAX_TERMINAL_RECEIPTS) {
            return;
        }
        for (const [commandId, receipt] of this.#executions) {
            if (isTerminal(receipt.state)) {
                this.#executions.delete(commandId);
                this.#terminalCount -= 1;
                if (this.#terminalCount <= MAX_TERMINAL_RECEIPTS) {
                    return;
                }
            }
        }
    };
}
