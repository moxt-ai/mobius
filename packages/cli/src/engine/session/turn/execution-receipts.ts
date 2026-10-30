import { createHash, randomUUID } from "node:crypto";
import {
    type CommandDelivery,
    decodeKnownSessionEventPayload,
    encodeSessionCancelBeforeStartCommand,
    type LastTurnOutcome,
    type SessionEventPayload,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import type { ExecutionReceiptTable } from "../../storage/session/execution-receipt-table.ts";

const MAX_TERMINAL_RECEIPTS = 1_024;

export type RuntimeExecutionReceipt =
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "accepted";
      }>
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "duplicate";
          outcome: SessionEventPayload | undefined;
      }>
    | { readonly kind: "conflict" }
    | { readonly kind: "expired" };

type ExecutionState =
    | { readonly kind: "pending" }
    | { readonly kind: "started" }
    | { readonly kind: "settled-before-start"; readonly outcome: string }
    | { readonly kind: "settled-after-start"; readonly outcome: string };

// Keep the execution claim after settlement: the outcome alone cannot decide replay safety.
function executionStarted(state: ExecutionState): boolean {
    switch (state.kind) {
        case "pending":
        case "settled-before-start":
            return false;
        case "started":
        case "settled-after-start":
            return true;
        default: {
            const unreachable: never = state;
            throw new Error("Unexpected execution state", { cause: unreachable });
        }
    }
}

function executionOutcome(state: ExecutionState): string | null {
    switch (state.kind) {
        case "pending":
        case "started":
            return null;
        case "settled-before-start":
        case "settled-after-start":
            return state.outcome;
        default: {
            const unreachable: never = state;
            throw new Error("Unexpected execution state", { cause: unreachable });
        }
    }
}

function settledExecution(state: ExecutionState, outcome: string): ExecutionState {
    return { kind: executionStarted(state) ? "settled-after-start" : "settled-before-start", outcome };
}

type ExecutionReceipt = Readonly<{
    admissionOrder: number;
    attemptId: string;
    commandHash: string;
    sessionId: string;
    state: ExecutionState;
}>;

export class ExecutionReceipts {
    readonly #executions = new Map<string, ExecutionReceipt>();
    readonly #recoveredCommands = new Set<string>();

    readonly #table: ExecutionReceiptTable;
    #closing = false;
    readonly #onCount: (count: number) => void;
    constructor(table: ExecutionReceiptTable, onCount: (count: number) => void = () => undefined) {
        this.#onCount = onCount;
        this.#table = table;
        for (const { commandId, started, outcome, updatedAt: _updatedAt, ...identity } of table.list()) {
            const state: ExecutionState = { kind: started ? "started" : "pending" };
            this.#executions.set(commandId, {
                ...identity,
                state: outcome === null ? state : settledExecution(state, outcome),
            });
            this.#recoveredCommands.add(commandId);
        }
    }
    readonly #save = (
        commandId: string,
        receipt: ExecutionReceipt,
        durableOutcome: string | null = executionOutcome(receipt.state),
    ): void => {
        const { state, ...identity } = receipt;
        const evicted = this.#closing
            ? []
            : this.#table.save(
                  {
                      ...identity,
                      commandId,
                      started: executionStarted(state),
                      outcome: durableOutcome,
                      updatedAt: new Date().toISOString(),
                  },
                  MAX_TERMINAL_RECEIPTS,
              );
        // Live failure detail may quote user input; only the durable receipt goes to the table.
        this.#executions.set(commandId, receipt);
        for (const evictedCommandId of evicted) {
            this.#executions.delete(evictedCommandId);
            this.#recoveredCommands.delete(evictedCommandId);
        }
        let activeCount = 0;
        for (const entry of this.#executions.values()) {
            if (executionOutcome(entry.state) === null) {
                activeCount += 1;
            }
        }
        this.#onCount(activeCount);
    };
    readonly #nextAdmissionOrder = (): number => {
        let latest = 0;
        for (const receipt of this.#executions.values()) {
            latest = Math.max(latest, receipt.admissionOrder);
        }
        return latest + 1;
    };
    readonly beginShutdown = (): void => {
        this.#closing = true;
    };
    readonly outcome = (commandId: string): SessionEventPayload | undefined => {
        const receipt = this.#executions.get(commandId);
        const outcome = receipt === undefined ? null : executionOutcome(receipt.state);
        return outcome === null ? undefined : (decodeKnownSessionEventPayload(JSON.parse(outcome)) ?? undefined);
    };
    /** The command's delivery as these receipts know it; another Session's command reads as unknown. */
    readonly delivery = (commandId: string, sessionId: string): CommandDelivery => {
        const receipt = this.#executions.get(commandId);
        if (receipt === undefined) {
            return this.#table.identity(commandId)?.sessionId === sessionId
                ? { state: "expired" }
                : { state: "unknown" };
        }
        if (receipt.sessionId !== sessionId) {
            return { state: "unknown" };
        }
        if (executionOutcome(receipt.state) === null) {
            return { state: "accepted" };
        }
        const outcome = this.outcome(commandId);
        if (outcome?.type !== "lifecycle-metadata") {
            return { state: "expired" };
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { state: "completed", stopReason: outcome.payload.stopReason };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return { code: outcome.payload.code, state: "failed" };
            default:
                return { state: "expired" };
        }
    };
    /**
     * How the Session's most recently admitted turn ended. Admission order survives updates and
     * restarts. Commands that never started (queued, or reserved for cancellation) are not turns,
     * unless they failed before starting. Undefined while the latest turn runs or none is retained.
     */
    readonly lastTurn = (sessionId: string): LastTurnOutcome | undefined => {
        let last: string | undefined;
        let latestOrder = 0;
        for (const [commandId, receipt] of this.#executions) {
            if (receipt.sessionId !== sessionId) {
                continue;
            }
            const outcome = this.outcome(commandId);
            const failedBeforeStart =
                outcome?.type === "lifecycle-metadata" && outcome.payload.kind === "prompt.failed-before-start";
            if ((executionStarted(receipt.state) || failedBeforeStart) && receipt.admissionOrder > latestOrder) {
                last = commandId;
                latestOrder = receipt.admissionOrder;
            }
        }
        const outcome = last === undefined ? undefined : this.outcome(last);
        if (last === undefined || outcome?.type !== "lifecycle-metadata") {
            return undefined;
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { commandId: last, state: "completed", stopReason: outcome.payload.stopReason };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return {
                    code: outcome.payload.code,
                    commandId: last,
                    message: outcome.payload.message,
                    state: "failed",
                };
            default:
                return undefined;
        }
    };
    /** Started identities remain authoritative after their detailed receipt is evicted. */
    readonly hasStarted = (commandId: string, sessionId: string): boolean => {
        const receipt = this.#executions.get(commandId);
        return (
            (receipt?.sessionId === sessionId && executionStarted(receipt.state)) ||
            this.#table.identity(commandId)?.sessionId === sessionId
        );
    };

    /** Reserves an unseen command for cancellation before a delayed prompt can claim its identity. */
    readonly recordCancellationBeforeAdmission = (
        commandId: string,
        sessionId: string,
    ): SessionEventPayload | undefined => {
        const existing = this.#executions.get(commandId);
        if (existing !== undefined) {
            return existing.sessionId === sessionId ? this.outcome(commandId) : undefined;
        }
        const identity = this.#table.identity(commandId);
        if (identity !== undefined) {
            // Preserve the legacy cancellation acknowledgement without replacing an executed
            // identity with a before-admission reservation after its detailed receipt expired.
            return identity.sessionId === sessionId
                ? {
                      type: "lifecycle-metadata",
                      payload: { kind: "prompt.completed", commandId, stopReason: "cancelled" },
                  }
                : undefined;
        }
        const outcome: SessionEventPayload = {
            type: "lifecycle-metadata",
            payload: { kind: "prompt.completed", commandId, stopReason: "cancelled", execution: "not-started" },
        };
        // The identifier belongs to the cancellation, so a later prompt conflicts rather than executing.
        const commandHash = createHash("sha256")
            .update(
                encodeSessionCancelBeforeStartCommand({
                    commandId,
                    kind: "session.cancel-before-start",
                    sessionId,
                }),
            )
            .digest("hex");
        this.#save(commandId, {
            admissionOrder: this.#nextAdmissionOrder(),
            attemptId: randomUUID(),
            commandHash,
            sessionId,
            state: {
                kind: "settled-before-start",
                outcome: JSON.stringify({ ...outcome, recordedAt: new Date().toISOString() }),
            },
        });
        return outcome;
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
        const outcome = { type: "lifecycle-metadata", payload, recordedAt: event.recordedAt };
        this.#save(
            payload.commandId,
            { ...receipt, state: settledExecution(receipt.state, JSON.stringify(outcome)) },
            JSON.stringify({ ...outcome, payload: sanitized }),
        );
    };
    readonly recover = (): readonly {
        readonly sessionId: string;
        readonly event: SessionEventPayload;
        readonly recordedAt: string;
    }[] => {
        const recovered: { sessionId: string; event: SessionEventPayload; recordedAt: string }[] = [];
        for (const [commandId, receipt] of [...this.#executions]) {
            const outcome = executionOutcome(receipt.state);
            const event: SessionEventPayload | null =
                outcome === null
                    ? {
                          type: "lifecycle-metadata",
                          payload: executionStarted(receipt.state)
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
                    : decodeKnownSessionEventPayload(JSON.parse(outcome));
            if (event === null) {
                continue;
            }
            const recordedAt =
                outcome === null
                    ? new Date().toISOString()
                    : z.object({ recordedAt: z.string() }).parse(JSON.parse(outcome)).recordedAt;
            recovered.push({ sessionId: receipt.sessionId, event, recordedAt });
            if (outcome === null) {
                this.#save(commandId, {
                    ...receipt,
                    state: settledExecution(receipt.state, JSON.stringify({ ...event, recordedAt })),
                });
            }
        }
        return recovered;
    };

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): RuntimeExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        let existing = this.#executions.get(commandId);
        const previous = this.outcome(commandId);
        if (
            existing?.sessionId === sessionId &&
            !executionStarted(existing.state) &&
            previous?.type === "lifecycle-metadata" &&
            previous.payload.kind === "prompt.failed-before-start" &&
            previous.payload.code === "runtime_restarted"
        ) {
            this.#table.remove(commandId);
            this.#executions.delete(commandId);
            this.#recoveredCommands.delete(commandId);
            existing = undefined;
        }
        if (existing !== undefined) {
            if (existing.sessionId !== sessionId || existing.commandHash !== commandHash) {
                return { kind: "conflict" };
            }
            return {
                attemptId: existing.attemptId,
                commandId,
                kind: "duplicate",
                outcome: this.#recoveredCommands.has(commandId) ? this.outcome(commandId) : undefined,
            };
        }
        const identity = this.#table.identity(commandId);
        if (identity !== undefined) {
            return identity.sessionId === sessionId && identity.commandHash === commandHash
                ? { kind: "expired" }
                : { kind: "conflict" };
        }
        const attemptId = randomUUID();
        this.#save(commandId, {
            admissionOrder: this.#nextAdmissionOrder(),
            attemptId,
            commandHash,
            sessionId,
            state: { kind: "pending" },
        });
        return { attemptId, commandId, kind: "accepted" };
    };

    readonly markExecutionStarted = (commandId: string): void => {
        const current = this.#executions.get(commandId);
        if (current === undefined) {
            throw new Error("The runtime execution receipt does not exist");
        }
        const state = current.state;
        switch (state.kind) {
            case "pending":
                this.#save(commandId, { ...current, state: { kind: "started" } });
                return;
            case "started":
                return;
            case "settled-before-start":
            case "settled-after-start":
                throw new Error("The runtime execution transition is invalid");
            default: {
                const unreachable: never = state;
                throw new Error("Unexpected execution state", { cause: unreachable });
            }
        }
    };

    /** Only commands without a terminal result can still be cancelled. */
    readonly findUnsettledAttemptId = (commandId: string, sessionId: string): string | null => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && executionOutcome(receipt.state) === null ? receipt.attemptId : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && executionOutcome(receipt.state) !== null;
    };

    readonly close = (): void => {
        this.#executions.clear();
        this.#recoveredCommands.clear();
    };
}
