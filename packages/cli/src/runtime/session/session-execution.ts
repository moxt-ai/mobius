import {
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import type { RuntimeOperationState } from "../admission.ts";
import { ActiveRuntimeTurn, type RecordedSessionEvent } from "./turn/active-turn.ts";

export type SessionAdmission =
    | { readonly kind: "available"; readonly disposition: string }
    | { readonly kind: "busy" }
    | { readonly kind: "queue-target-unavailable" };

const waitForTurnCompletion = (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<void> => {
    waitSignal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (
            result: { readonly kind: "completed" } | { readonly kind: "failed"; readonly error: unknown },
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            waitSignal.removeEventListener("abort", onAbort);
            if (result.kind === "completed") {
                resolve();
            } else {
                reject(result.error);
            }
        };
        const onAbort = (): void => finish({ error: waitSignal.reason, kind: "failed" });
        waitSignal.addEventListener("abort", onAbort, { once: true });
        void turn.completion.then(
            () => finish({ kind: "completed" }),
            (error: unknown) => finish({ error, kind: "failed" }),
        );
    });
};

/** One session's in-flight turns: FIFO admission, steering, and interaction recording. */
export class SessionExecutionState {
    readonly #sessionId: string;
    readonly #turnsByCommandId = new Map<string, ActiveRuntimeTurn>();
    readonly #operations: RuntimeOperationState;

    constructor(sessionId: string, operations: RuntimeOperationState) {
        this.#sessionId = sessionId;
        this.#operations = operations;
    }

    readonly isEmpty = (): boolean => this.#turnsByCommandId.size === 0;

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveRuntimeTurn => {
        const turn = new ActiveRuntimeTurn(command, attemptId);
        this.#turnsByCommandId.set(command.commandId, turn);
        return turn;
    };

    readonly get = (commandId: string): ActiveRuntimeTurn | undefined => this.#turnsByCommandId.get(commandId);

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turnsByCommandId.delete(turn.command.commandId);
        turn.finish();
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if ("commandId" in event) {
            const turn = this.#turnsByCommandId.get(event.commandId);
            if (turn !== undefined) {
                return turn.recordEvent(event);
            }
        }
        if (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
            for (const turn of this.#turnsByCommandId.values()) {
                if (turn.matchesInteraction(event.interactionId, this.#sessionId)) {
                    return turn.recordEvent(event);
                }
            }
        }
        return event;
    };

    readonly recordSteeringPrompt = (command: SessionPromptCommand): boolean => {
        const target = this.#turnsByCommandId.get(command.targetCommandId);
        return target?.recordSteeringPrompt(command) ?? false;
    };

    readonly turns = (): readonly ActiveRuntimeTurn[] => [...this.#turnsByCommandId.values()];

    readonly close = async (): Promise<void> => {
        const turns = [...this.#turnsByCommandId.values()];
        for (const turn of turns) {
            turn.abortRuntime();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    readonly admitAndWait = async (
        turn: ActiveRuntimeTurn,
        waitSignal: AbortSignal,
        onQueued: () => void,
    ): Promise<SessionAdmission> => {
        const command = turn.command;
        waitSignal.throwIfAborted();
        const head = (): ActiveRuntimeTurn | undefined =>
            [...this.#turnsByCommandId.values()].find(
                (turn) => turn.command.disposition !== SessionPromptDisposition.Steer,
            );
        // The target guards admission only. Accepted work belongs to the Session
        // FIFO and must survive the original target finishing or being cancelled.
        if (command.disposition === SessionPromptDisposition.Queue) {
            const target = head();
            if (
                (target === turn || target?.command.commandId !== command.targetCommandId) &&
                !this.#operations.isTerminalExecution(command.targetCommandId, this.#sessionId)
            ) {
                return { kind: "queue-target-unavailable" };
            }
            turn.enqueue();
            onQueued();
        }
        if (turn.effectiveDisposition() === SessionPromptDisposition.Steer) {
            return { disposition: SessionPromptDisposition.Steer, kind: "available" };
        }
        for (;;) {
            waitSignal.throwIfAborted();
            const first = head();
            if (first === undefined || first === turn) {
                return { disposition: turn.effectiveDisposition(), kind: "available" };
            }
            if (command.disposition !== SessionPromptDisposition.Queue) {
                return { kind: "busy" };
            }
            const promotion = turn.queuePromotion();
            if (promotion === null) {
                throw new Error("The queued prompt cannot be promoted");
            }
            const decision = await Promise.race([
                waitForTurnCompletion(first, waitSignal).then(() => "target-completed" as const),
                promotion.then(() => "promoted" as const),
            ]);
            if (decision === "promoted") {
                return { disposition: SessionPromptDisposition.Steer, kind: "available" };
            }
        }
    };
}
