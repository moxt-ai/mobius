import { createHash, randomUUID } from "node:crypto";
import {
    type SessionEventPayload,
    type SessionLiveEvent,
    sessionEventPayloadSchema,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import type { ExecutionReceiptTable } from "../../storage/session/execution-receipt-table.ts";

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

type TerminalExecutionState = "succeeded" | "failed" | "cancelled";
type StoredExecution = Readonly<{
    attemptId: string;
    commandHash: string;
    sessionId: string;
}> &
    (
        | Readonly<{ state: "dispatching"; started: false; outcome: null }>
        | Readonly<{ state: "running"; started: true; outcome: string | null }>
        | Readonly<{ state: TerminalExecutionState; started: boolean; outcome: string | null }>
    );

function isTerminal(state: RuntimeExecutionState): state is TerminalExecutionState {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class ExecutionReceipts {
    readonly #executions = new Map<string, StoredExecution>();
    readonly #terminalCountBySession = new Map<string, number>();

    readonly #table: ExecutionReceiptTable | undefined;
    #closing = false;
    #activeCount = 0;
    readonly #onCount: (count: number) => void;
    constructor(table?: ExecutionReceiptTable, onCount: (count: number) => void = () => undefined) {
        this.#onCount = onCount;
        this.#table = table;
        for (const row of table?.list() ?? []) {
            this.#executions.set(row.commandId, row);
            if (!isTerminal(row.state)) {
                this.#activeCount += 1;
            }
            if (isTerminal(row.state)) {
                this.#terminalCountBySession.set(
                    row.sessionId,
                    (this.#terminalCountBySession.get(row.sessionId) ?? 0) + 1,
                );
            }
        }
    }
    readonly #save = (commandId: string, receipt: StoredExecution): void => {
        if (!this.#closing) {
            this.#table?.save({ ...receipt, commandId, updatedAt: new Date().toISOString() });
        }
        const previous = this.#executions.get(commandId);
        const wasActive = previous !== undefined && !isTerminal(previous.state);
        if (isTerminal(receipt.state)) {
            this.#executions.delete(commandId);
        }
        this.#executions.set(commandId, receipt);
        this.#activeCount += Number(!isTerminal(receipt.state)) - Number(wasActive);
        this.#onCount(this.#activeCount);
        if (isTerminal(receipt.state) && (previous === undefined || !isTerminal(previous.state))) {
            this.#terminalCountBySession.set(
                receipt.sessionId,
                (this.#terminalCountBySession.get(receipt.sessionId) ?? 0) + 1,
            );
            this.pruneTerminalReceipts(receipt.sessionId);
        }
    };
    readonly beginShutdown = (): void => {
        this.#closing = true;
    };
    readonly outcome = (commandId: string): SessionEventPayload | undefined => {
        const receipt = this.#executions.get(commandId);
        return receipt?.outcome === null || receipt === undefined
            ? undefined
            : sessionEventPayloadSchema.parse(JSON.parse(receipt.outcome));
    };
    readonly recordOutcome = (event: SessionLiveEvent): void => {
        if (event.type !== "lifecycle-metadata") {
            return;
        }
        const payload = event.payload;
        if (
            payload.kind !== "prompt.completed" &&
            payload.kind !== "prompt.failed" &&
            payload.kind !== "prompt.failed-before-start"
        ) {
            return;
        }
        const receipt = this.#executions.get(payload.commandId);
        if (receipt === undefined) {
            return;
        }
        const sanitized =
            payload.kind === "prompt.completed"
                ? payload
                : { ...payload, message: "The local Agent could not complete the request" };
        this.#save(payload.commandId, {
            ...receipt,
            state:
                payload.kind === "prompt.completed"
                    ? payload.stopReason === "cancelled"
                        ? "cancelled"
                        : "succeeded"
                    : "failed",
            outcome: JSON.stringify({ type: "lifecycle-metadata", payload: sanitized, recordedAt: event.recordedAt }),
        });
    };
    readonly recover = (): readonly {
        readonly sessionId: string;
        readonly event: SessionEventPayload;
        readonly recordedAt: string;
    }[] => {
        const recovered: { sessionId: string; event: SessionEventPayload; recordedAt: string }[] = [];
        for (const [commandId, receipt] of [...this.#executions]) {
            const event: SessionEventPayload =
                receipt.outcome === null
                    ? {
                          type: "lifecycle-metadata",
                          payload: receipt.started
                              ? {
                                    kind: "prompt.failed",
                                    commandId,
                                    attemptId: receipt.attemptId,
                                    code: "runtime_restarted",
                                    message: "The local runtime restarted while this request was running",
                                }
                              : {
                                    kind: "prompt.failed-before-start",
                                    commandId,
                                    code: "runtime_restarted",
                                    message: "The local runtime restarted before this request started",
                                },
                      }
                    : sessionEventPayloadSchema.parse(JSON.parse(receipt.outcome));
            const recordedAt =
                receipt.outcome === null
                    ? new Date().toISOString()
                    : z.object({ recordedAt: z.string() }).parse(JSON.parse(receipt.outcome)).recordedAt;
            recovered.push({ sessionId: receipt.sessionId, event, recordedAt });
            if (!isTerminal(receipt.state)) {
                const state =
                    event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"
                        ? event.payload.stopReason === "cancelled"
                            ? "cancelled"
                            : "succeeded"
                        : "failed";
                this.#save(commandId, { ...receipt, state, outcome: JSON.stringify({ ...event, recordedAt }) });
            }
        }
        return recovered;
    };

    readonly terminalOutcomes = (
        sessionId: string,
    ): readonly {
        readonly event: SessionEventPayload;
        readonly recordedAt: string;
    }[] =>
        [...this.#executions.values()].flatMap((receipt) => {
            if (receipt.sessionId !== sessionId || receipt.outcome === null) {
                return [];
            }
            const decoded: unknown = JSON.parse(receipt.outcome);
            return [
                {
                    event: sessionEventPayloadSchema.parse(decoded),
                    recordedAt: z.object({ recordedAt: z.string() }).parse(decoded).recordedAt,
                },
            ];
        });

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): RuntimeExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        let existing = this.#executions.get(commandId);
        const previous = this.outcome(commandId);
        if (
            existing?.sessionId === sessionId &&
            !existing.started &&
            previous?.type === "lifecycle-metadata" &&
            previous.payload.kind === "prompt.failed-before-start" &&
            previous.payload.code === "runtime_restarted"
        ) {
            this.#executions.delete(commandId);
            this.#table?.remove(commandId);
            this.#terminalCountBySession.set(
                sessionId,
                Math.max(0, (this.#terminalCountBySession.get(sessionId) ?? 1) - 1),
            );
            existing = undefined;
        }
        if (existing !== undefined) {
            if (existing.sessionId !== sessionId || existing.commandHash !== commandHash) {
                return { kind: "conflict" };
            }
            return { attemptId: existing.attemptId, commandId, kind: "duplicate", state: existing.state };
        }
        const attemptId = randomUUID();
        this.#save(commandId, {
            attemptId,
            commandHash,
            sessionId,
            state: "dispatching",
            started: false,
            outcome: null,
        });
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
        if (state === "running") {
            this.#save(commandId, { ...current, state, started: true });
        } else if (isTerminal(state)) {
            this.#save(commandId, { ...current, state });
        }
    };

    /** Only commands without a terminal result can still be cancelled. */
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
        this.#activeCount = 0;
    };

    private readonly pruneTerminalReceipts = (sessionId: string): void => {
        if ((this.#terminalCountBySession.get(sessionId) ?? 0) <= MAX_TERMINAL_RECEIPTS) {
            return;
        }
        for (const [commandId, receipt] of this.#executions) {
            if (receipt.sessionId === sessionId && isTerminal(receipt.state)) {
                this.#executions.delete(commandId);
                this.#table?.remove(commandId);
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
