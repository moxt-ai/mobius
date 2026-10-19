import {
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionLiveEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { ActiveDaemonTurn, type RecordedSessionEvent } from "./active-turn.ts";
import type { DaemonOperationState } from "./relay/daemon-operation-state.ts";

const waitForTurnCompletion = (turn: ActiveDaemonTurn, waitSignal: AbortSignal): Promise<void> => {
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

/** Owns Runtime prompt admission and recovery; Relay connection lifetimes do not own either. */
export class DaemonTurnRegistry {
    readonly #inFlightByCommandId = new Map<string, ActiveDaemonTurn>();
    readonly #operations: DaemonOperationState;

    constructor(operations: DaemonOperationState) {
        this.#operations = operations;
    }

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveDaemonTurn => {
        const turn = new ActiveDaemonTurn(command, attemptId);
        this.#inFlightByCommandId.set(command.commandId, turn);
        return turn;
    };

    readonly get = (commandId: string): ActiveDaemonTurn | undefined => this.#inFlightByCommandId.get(commandId);

    readonly finish = (turn: ActiveDaemonTurn): void => {
        this.#inFlightByCommandId.delete(turn.command.commandId);
        turn.finish();
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if ("commandId" in event) {
            const turn = this.#inFlightByCommandId.get(event.commandId);
            if (turn !== undefined && turn.command.sessionId === event.sessionId) {
                return turn.recordEvent(event);
            }
        }
        if (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
            for (const turn of this.#inFlightByCommandId.values()) {
                if (turn.matchesInteraction(event.interactionId, event.sessionId)) {
                    return turn.recordEvent(event);
                }
            }
        }
        return event;
    };

    readonly recordSessionEvent = (event: SessionLiveEvent): void => {
        if (
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "session.permission.requested" ||
                event.payload.kind === "session.permission.resolved" ||
                event.payload.kind === "session.elicitation.requested" ||
                event.payload.kind === "session.elicitation.resolved")
        ) {
            this.recordEvent(event.payload.event);
        }
    };

    readonly recordSteeringPrompt = (command: SessionPromptCommand): boolean => {
        const target = this.#inFlightByCommandId.get(command.targetCommandId);
        return target?.recordSteeringPrompt(command) ?? false;
    };

    readonly executionSnapshot = async (matches: (command: SessionPromptCommand) => Promise<boolean>) => {
        const matching: ActiveDaemonTurn[] = [];
        for (const turn of this.#inFlightByCommandId.values()) {
            if (await matches(turn.command)) {
                matching.push(turn);
            }
        }
        const current = matching.filter((turn) => this.#inFlightByCommandId.get(turn.command.commandId) === turn);
        return {
            turn: current.map((turn) => turn.snapshot()).find((snapshot) => snapshot !== null) ?? null,
            queued: current
                .filter((turn) => turn.isQueued())
                .map(({ command }) => ({
                    commandId: command.commandId,
                    prompt: command.prompt,
                    images: command.images,
                })),
        };
    };

    readonly close = async (): Promise<void> => {
        const turns = [...this.#inFlightByCommandId.values()];
        for (const turn of turns) {
            turn.abortDaemon();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    readonly admitAndWait = async (
        turn: ActiveDaemonTurn,
        waitSignal: AbortSignal,
        onQueued: () => void,
    ): Promise<
        | { readonly kind: "available"; readonly disposition: string }
        | { readonly kind: "busy" }
        | { readonly kind: "queue-target-unavailable" }
    > => {
        const command = turn.command;
        waitSignal.throwIfAborted();
        const head = (): ActiveDaemonTurn | undefined =>
            [...this.#inFlightByCommandId.values()].find(
                (turn) =>
                    turn.command.sessionId === command.sessionId &&
                    turn.command.disposition !== SessionPromptDisposition.Steer,
            );
        // The target guards admission only. Accepted work belongs to the Session
        // FIFO and must survive the original target finishing or being cancelled.
        if (command.disposition === SessionPromptDisposition.Queue) {
            const target = head();
            if (
                (target === turn || target?.command.commandId !== command.targetCommandId) &&
                !this.#operations.isTerminalExecution(command.targetCommandId, command.sessionId)
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
