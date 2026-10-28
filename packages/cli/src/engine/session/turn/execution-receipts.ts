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

type StoredExecution = Readonly<{
    attemptId: string;
    commandHash: string;
    sessionId: string;
    started: boolean;
    outcome: string | null;
}>;

export class ExecutionReceipts {
    readonly #executions = new Map<string, StoredExecution>();
    readonly #recoveredCommands = new Set<string>();

    readonly #table: ExecutionReceiptTable;
    #closing = false;
    #activeCount = 0;
    readonly #onCount: (count: number) => void;
    constructor(table: ExecutionReceiptTable, onCount: (count: number) => void = () => undefined) {
        this.#onCount = onCount;
        this.#table = table;
        for (const row of table.list()) {
            this.#executions.set(row.commandId, row);
            this.#recoveredCommands.add(row.commandId);
            if (row.outcome === null) {
                this.#activeCount += 1;
            }
        }
    }
    readonly #save = (commandId: string, receipt: StoredExecution): void => {
        const evicted = this.#closing
            ? []
            : this.#table.save({ ...receipt, commandId, updatedAt: new Date().toISOString() }, MAX_TERMINAL_RECEIPTS);
        const previous = this.#executions.get(commandId);
        const wasActive = previous?.outcome === null;
        this.#executions.set(commandId, receipt);
        for (const evictedCommandId of evicted) {
            this.#executions.delete(evictedCommandId);
            this.#recoveredCommands.delete(evictedCommandId);
        }
        this.#activeCount += Number(receipt.outcome === null) - Number(wasActive);
        this.#onCount(this.#activeCount);
    };
    readonly beginShutdown = (): void => {
        this.#closing = true;
    };
    readonly outcome = (commandId: string): SessionEventPayload | undefined => {
        const receipt = this.#executions.get(commandId);
        return receipt?.outcome === null || receipt === undefined
            ? undefined
            : (decodeKnownSessionEventPayload(JSON.parse(receipt.outcome)) ?? undefined);
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
        if (receipt.outcome === null) {
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
     * How the Session's most recent started command ended. Receipts keep admission order, or the
     * order they last changed after a restart; commands that never started (queued, or reserved for
     * cancellation) are not turns, unless a restart failed them before they could start. Undefined
     * while that command still runs, or when no turn is retained.
     */
    readonly lastTurn = (sessionId: string): LastTurnOutcome | undefined => {
        let last: string | undefined;
        for (const [commandId, receipt] of this.#executions) {
            if (receipt.sessionId !== sessionId) {
                continue;
            }
            const outcome = receipt.outcome === null ? undefined : this.outcome(commandId);
            const failedBeforeStart =
                outcome?.type === "lifecycle-metadata" && outcome.payload.kind === "prompt.failed-before-start";
            if (receipt.started || failedBeforeStart) {
                last = commandId;
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
    /** Reserves an unseen command for cancellation before a delayed prompt can claim its identity. */
    readonly recordCancellationBeforeAdmission = (
        commandId: string,
        sessionId: string,
    ): SessionEventPayload | undefined => {
        const existing = this.#executions.get(commandId);
        if (existing !== undefined) {
            return existing.sessionId === sessionId ? this.outcome(commandId) : undefined;
        }
        const outcome: SessionEventPayload = {
            type: "lifecycle-metadata",
            payload: { kind: "prompt.completed", commandId, stopReason: "cancelled" },
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
            attemptId: randomUUID(),
            commandHash,
            sessionId,
            started: false,
            outcome: JSON.stringify({ ...outcome, recordedAt: new Date().toISOString() }),
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
        // The lifecycle event already carries the bounded client-facing failure. Preserve it so
        // live delivery, command replay and last-turn recovery report the same outcome.
        this.#save(payload.commandId, {
            ...receipt,
            outcome: JSON.stringify({ type: "lifecycle-metadata", payload, recordedAt: event.recordedAt }),
        });
    };
    readonly recover = (): readonly {
        readonly sessionId: string;
        readonly event: SessionEventPayload;
        readonly recordedAt: string;
    }[] => {
        const recovered: { sessionId: string; event: SessionEventPayload; recordedAt: string }[] = [];
        for (const [commandId, receipt] of [...this.#executions]) {
            const event: SessionEventPayload | null =
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
                    : decodeKnownSessionEventPayload(JSON.parse(receipt.outcome));
            if (event === null) {
                continue;
            }
            const recordedAt =
                receipt.outcome === null
                    ? new Date().toISOString()
                    : z.object({ recordedAt: z.string() }).parse(JSON.parse(receipt.outcome)).recordedAt;
            recovered.push({ sessionId: receipt.sessionId, event, recordedAt });
            if (receipt.outcome === null) {
                this.#save(commandId, { ...receipt, outcome: JSON.stringify({ ...event, recordedAt }) });
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
            !existing.started &&
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
            attemptId,
            commandHash,
            sessionId,
            started: false,
            outcome: null,
        });
        return { attemptId, commandId, kind: "accepted" };
    };

    readonly markExecutionStarted = (commandId: string): void => {
        const current = this.#executions.get(commandId);
        if (current === undefined) {
            throw new Error("The runtime execution receipt does not exist");
        }
        if (current.outcome !== null) {
            throw new Error("The runtime execution transition is invalid");
        }
        if (!current.started) {
            this.#save(commandId, { ...current, started: true });
        }
    };

    /** Only commands without a terminal result can still be cancelled. */
    readonly findUnsettledAttemptId = (commandId: string, sessionId: string): string | null => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && receipt.outcome === null ? receipt.attemptId : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const receipt = this.#executions.get(commandId);
        return receipt?.sessionId === sessionId && receipt.outcome !== null;
    };

    readonly close = (): void => {
        this.#executions.clear();
        this.#recoveredCommands.clear();
        this.#activeCount = 0;
    };
}
