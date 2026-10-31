import { createHash, randomUUID } from "node:crypto";
import {
    type CommandDelivery,
    decodeKnownSessionEventPayload,
    encodeSessionCancelBeforeStartCommand,
    isPromptTerminal,
    type LastTurnOutcome,
    promptCompletion,
    type SessionEventPayload,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import type {
    CommandCancellationTable,
    PersistedCommandCancellation,
} from "../../storage/session/command-cancellation-table.ts";
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
          // Whether the original command has ended, as its receipt records it.
          state: "settled" | "unsettled";
      }>
    | { readonly kind: "conflict" }
    | { readonly kind: "expired" };

/** What a cancellation before admission found: a cancellation it recorded, or an outcome recorded earlier. */
export type CancellationBeforeAdmission =
    | { readonly kind: "recorded"; readonly outcome: SessionEventPayload }
    | { readonly kind: "restated"; readonly outcome: SessionEventPayload }
    | { readonly kind: "unavailable" };

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

function cancelledBeforeStart(state: ExecutionState): boolean {
    if (state.kind !== "settled-before-start") {
        return false;
    }
    const outcome = decodeKnownSessionEventPayload(JSON.parse(state.outcome));
    return (
        outcome?.type === "lifecycle-metadata" &&
        outcome.payload.kind === "prompt.completed" &&
        promptCompletion(outcome.payload).kind === "cancelled"
    );
}

/** A restart failed the command before it started, so its identifier may run again. */
function restartedBeforeStart(state: ExecutionState): boolean {
    if (state.kind !== "settled-before-start") {
        return false;
    }
    const outcome = decodeKnownSessionEventPayload(JSON.parse(state.outcome));
    return (
        outcome?.type === "lifecycle-metadata" &&
        outcome.payload.kind === "prompt.failed-before-start" &&
        outcome.payload.code === "runtime_restarted"
    );
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

/** What the three ledgers hold for one command identifier. */
type CommandRecord = Readonly<{
    // The detailed receipt, while it is retained.
    receipt: ExecutionReceipt | undefined;
    // The started identity left behind when the receipt was evicted.
    identity: Readonly<{ sessionId: string; commandHash: string }> | undefined;
    // The durable fact that the command was cancelled before it started.
    cancellation: PersistedCommandCancellation | undefined;
}>;

/** What a command identifier means to one Session: whether it may run, and what happened to it. */
type CommandStanding =
    // Nothing is recorded: the command may run.
    | { readonly kind: "unseen" }
    // Another Session owns the identifier.
    | { readonly kind: "foreign" }
    // A restart failed the command before it started: it may run again.
    | { readonly kind: "retryable"; readonly receipt: ExecutionReceipt }
    // The detailed receipt answers for the command, which does not run again.
    | { readonly kind: "retained"; readonly receipt: ExecutionReceipt }
    // The command started, and only its identity outlived the receipt.
    | { readonly kind: "expired"; readonly commandHash: string }
    // The command was cancelled before it started; any receipt still left has not recorded that yet.
    | { readonly kind: "cancelled"; readonly receipt: ExecutionReceipt | undefined };

function commandStanding({ receipt, identity, cancellation }: CommandRecord, sessionId: string): CommandStanding {
    if (receipt !== undefined) {
        if (receipt.sessionId !== sessionId) {
            return { kind: "foreign" };
        }
        if (
            !executionStarted(receipt.state) &&
            !cancelledBeforeStart(receipt.state) &&
            cancellation?.sessionId === sessionId
        ) {
            // The cancellation commits before its receipt, so a crash between the two leaves this pair.
            return { kind: "cancelled", receipt };
        }
        return restartedBeforeStart(receipt.state) ? { kind: "retryable", receipt } : { kind: "retained", receipt };
    }
    if (identity !== undefined) {
        return identity.sessionId === sessionId
            ? { kind: "expired", commandHash: identity.commandHash }
            : { kind: "foreign" };
    }
    if (cancellation !== undefined) {
        return cancellation.sessionId === sessionId ? { kind: "cancelled", receipt: undefined } : { kind: "foreign" };
    }
    return { kind: "unseen" };
}

const cancelledBeforeStartOutcome = (commandId: string): SessionEventPayload => ({
    type: "lifecycle-metadata",
    payload: { kind: "prompt.completed", commandId, stopReason: "cancelled", execution: "not-started" },
});

const unexpectedStanding = (standing: never): never => {
    throw new Error("Unexpected command standing", { cause: standing });
};

export class ExecutionReceipts {
    readonly #executions = new Map<string, ExecutionReceipt>();

    readonly #table: ExecutionReceiptTable;
    readonly #cancellations: CommandCancellationTable;
    #closing = false;
    readonly #onCount: (count: number) => void;
    constructor(
        table: ExecutionReceiptTable,
        cancellations: CommandCancellationTable,
        onCount: (count: number) => void = () => undefined,
    ) {
        this.#onCount = onCount;
        this.#table = table;
        this.#cancellations = cancellations;
        const retained: PersistedCommandCancellation[] = [];
        for (const { commandId, started, outcome, updatedAt: _updatedAt, ...identity } of table.list()) {
            const pending: ExecutionState = { kind: started ? "started" : "pending" };
            const state = outcome === null ? pending : settledExecution(pending, outcome);
            this.#executions.set(commandId, {
                ...identity,
                state,
            });
            if (cancelledBeforeStart(state)) {
                retained.push({ commandId, sessionId: identity.sessionId });
            }
        }
        cancellations.retain(retained);
    }
    /** Reads every ledger that can still change the answer and classifies the identifier for the Session. */
    readonly #standing = (commandId: string, sessionId: string): CommandStanding => {
        const receipt = this.#executions.get(commandId);
        // A started receipt, or one settled as cancelled, is final; only the others consult the cancellation ledger.
        const final = receipt !== undefined && (executionStarted(receipt.state) || cancelledBeforeStart(receipt.state));
        return commandStanding(
            {
                receipt,
                identity: receipt === undefined ? this.#table.identity(commandId) : undefined,
                cancellation: final ? undefined : this.#cancellations.read(commandId),
            },
            sessionId,
        );
    };
    readonly #remember = (commandId: string, receipt: ExecutionReceipt, evicted: readonly string[]): void => {
        // Live failure detail may quote user input; only the durable receipt goes to the table.
        this.#executions.set(commandId, receipt);
        for (const evictedCommandId of evicted) {
            this.#executions.delete(evictedCommandId);
        }
        let activeCount = 0;
        for (const entry of this.#executions.values()) {
            if (executionOutcome(entry.state) === null) {
                activeCount += 1;
            }
        }
        this.#onCount(activeCount);
    };
    readonly #save = (
        commandId: string,
        receipt: ExecutionReceipt,
        durableOutcome: string | null = executionOutcome(receipt.state),
    ): void => {
        const { state, ...identity } = receipt;
        if (!this.#closing && cancelledBeforeStart(state)) {
            // Commit the non-replayable fact first. A crash before saving/pruning the receipt must not reopen work.
            this.#cancellations.retain([{ commandId, sessionId: receipt.sessionId }]);
            // Cancellation is already authoritative even if the detailed receipt write fails.
            this.#remember(commandId, receipt, []);
        }
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
        this.#remember(commandId, receipt, evicted);
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
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
                return { state: "unknown" };
            case "expired":
                return { state: "expired" };
            case "cancelled":
                // A command that never started has no result to lose: it stays cancelled.
                return { state: "completed", stopReason: "cancelled" };
            case "retryable":
            case "retained":
                break;
            default:
                return unexpectedStanding(standing);
        }
        if (executionOutcome(standing.receipt.state) === null) {
            return { state: "accepted" };
        }
        const outcome = this.outcome(commandId);
        if (outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
            return { state: "expired" };
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { state: "completed", stopReason: outcome.payload.stopReason };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return { code: outcome.payload.code, state: "failed" };
        }
    };
    /**
     * How the Session's most recently admitted turn ended. Admission order survives updates and
     * restarts. Commands that never started (queued, or reserved for cancellation) are not turns,
     * unless they failed before starting. A steering command that completed as `steered` joined the
     * turn it steered, which reports for both; a steer not known to have joined (it failed, or a
     * restart interrupted it) keeps its own outcome. Undefined while the latest turn runs or none is
     * retained.
     */
    readonly lastTurn = (sessionId: string): LastTurnOutcome | undefined => {
        let last: string | undefined;
        let latestOrder = 0;
        for (const [commandId, receipt] of this.#executions) {
            if (receipt.sessionId !== sessionId) {
                continue;
            }
            const outcome = this.outcome(commandId);
            const payload = outcome?.type === "lifecycle-metadata" ? outcome.payload : undefined;
            const failedBeforeStart = payload?.kind === "prompt.failed-before-start";
            const steered = payload?.kind === "prompt.completed" && promptCompletion(payload).kind === "steered";
            if (
                (executionStarted(receipt.state) || failedBeforeStart) &&
                !steered &&
                receipt.admissionOrder > latestOrder
            ) {
                last = commandId;
                latestOrder = receipt.admissionOrder;
            }
        }
        const outcome = last === undefined ? undefined : this.outcome(last);
        if (last === undefined || outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
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
        }
    };
    /** Started identities remain authoritative after their detailed receipt is evicted. */
    readonly hasStarted = (commandId: string, sessionId: string): boolean => {
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
            case "cancelled":
            case "retryable":
                return false;
            case "expired":
                return true;
            case "retained":
                return executionStarted(standing.receipt.state);
            default:
                return unexpectedStanding(standing);
        }
    };

    /**
     * Reserves an unseen command for cancellation before a delayed prompt can claim its identity. A command that
     * already has an outcome keeps it, and the outcome is restated rather than recorded again.
     */
    readonly recordCancellationBeforeAdmission = (
        commandId: string,
        sessionId: string,
    ): CancellationBeforeAdmission => {
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "foreign":
                return { kind: "unavailable" };
            case "retryable":
            case "retained": {
                const outcome = this.outcome(commandId);
                return outcome === undefined ? { kind: "unavailable" } : { kind: "restated", outcome };
            }
            case "expired":
                // Preserve the legacy cancellation acknowledgement without replacing an executed
                // identity with a before-admission reservation after its detailed receipt expired.
                return {
                    kind: "restated",
                    outcome: {
                        type: "lifecycle-metadata",
                        payload: { kind: "prompt.completed", commandId, stopReason: "cancelled" },
                    },
                };
            case "cancelled":
                return { kind: "restated", outcome: cancelledBeforeStartOutcome(commandId) };
            case "unseen":
                break;
            default:
                return unexpectedStanding(standing);
        }
        const outcome = cancelledBeforeStartOutcome(commandId);
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
        return { kind: "recorded", outcome };
    };
    /**
     * Receipts follow their command's recorded lifecycle. `prompt.started` is recorded where the command is handed
     * to the Agent, so the started mark and the event clients see are one transition; a terminal event settles the
     * receipt. Nothing else marks a command started.
     */
    readonly record = (event: SessionLiveEvent): void => {
        if (event.type !== "lifecycle-metadata") {
            return;
        }
        const payload = event.payload;
        if (payload.kind === "prompt.started") {
            const receipt = this.#executions.get(payload.commandId);
            // A start reported after settlement does not reopen the execution.
            if (receipt?.state.kind === "pending") {
                this.#save(payload.commandId, { ...receipt, state: { kind: "started" } });
            }
            return;
        }
        if (!isPromptTerminal(payload)) {
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
            // A cancellation committed without its receipt settles the receipt as that cancellation.
            const restoreCancellation = this.#standing(commandId, receipt.sessionId).kind === "cancelled";
            const event: SessionEventPayload | null = restoreCancellation
                ? cancelledBeforeStartOutcome(commandId)
                : outcome === null
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
                restoreCancellation || outcome === null
                    ? new Date().toISOString()
                    : z.object({ recordedAt: z.string() }).parse(JSON.parse(outcome)).recordedAt;
            recovered.push({ sessionId: receipt.sessionId, event, recordedAt });
            if (restoreCancellation || outcome === null) {
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
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "foreign":
            case "cancelled":
                return { kind: "conflict" };
            case "retained":
                if (standing.receipt.commandHash !== commandHash) {
                    return { kind: "conflict" };
                }
                return {
                    attemptId: standing.receipt.attemptId,
                    commandId,
                    kind: "duplicate",
                    state: executionOutcome(standing.receipt.state) === null ? "unsettled" : "settled",
                };
            case "expired":
                return standing.commandHash === commandHash ? { kind: "expired" } : { kind: "conflict" };
            case "retryable":
                // Forget the restart failure, then claim as if it had never been received.
                this.#table.remove(commandId);
                this.#executions.delete(commandId);
                return this.claimExecution(commandId, sessionId, commandJson);
            case "unseen":
                break;
            default:
                return unexpectedStanding(standing);
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
        this.#cancellations.close();
    };
}
