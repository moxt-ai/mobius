import {
    type NativeSessionResult,
    type RecordedSessionEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { ActiveDaemonTurn } from "./daemon-active-turn.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

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

/** Owns in-flight prompts for one Runtime, independently of Relay connections. */
export class DaemonTurnRegistry {
    readonly #turns = new Map<string, ActiveDaemonTurn>();
    readonly #operations: DaemonOperationState;

    constructor(operations: DaemonOperationState) {
        this.#operations = operations;
    }

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveDaemonTurn => {
        const turn = new ActiveDaemonTurn(command, attemptId);
        this.#turns.set(command.commandId, turn);
        return turn;
    };

    readonly get = (commandId: string): ActiveDaemonTurn | undefined => this.#turns.get(commandId);

    readonly finish = (turn: ActiveDaemonTurn): void => {
        this.#turns.delete(turn.command.commandId);
        turn.finish();
    };

    readonly recordEvent = (event: RecordedSessionEvent): void => {
        for (const turn of this.#turns.values()) {
            turn.recordEvent(event);
        }
    };

    readonly queued = (
        matches: (command: SessionPromptCommand) => boolean,
    ): Extract<NativeSessionResult, { readonly action: "active-turn" }>["queued"] =>
        [...this.#turns.values()]
            .filter((turn) => matches(turn.command) && turn.isQueued())
            .map(({ command }) => ({ commandId: command.commandId, prompt: command.prompt, images: command.images }));

    readonly executionSnapshot = (matches: (command: SessionPromptCommand) => boolean) => ({
        turn: this.snapshot(matches),
        queued: this.queued(matches),
    });

    readonly snapshot = (matches: (command: SessionPromptCommand) => boolean): ActiveTurnSnapshot => {
        for (const turn of this.#turns.values()) {
            if (!matches(turn.command)) {
                continue;
            }
            const snapshot = turn.snapshot();
            if (snapshot !== null) {
                return snapshot;
            }
        }
        return null;
    };

    readonly close = async (): Promise<void> => {
        const turns = [...this.#turns.values()];
        for (const turn of turns) {
            turn.abortDaemon();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    readonly waitForAvailability = async (
        command: SessionPromptCommand,
        queuedTurn: ActiveDaemonTurn,
        waitSignal: AbortSignal,
    ): Promise<
        | { readonly kind: "available"; readonly disposition: string }
        | { readonly kind: "busy" }
        | { readonly kind: "queue-target-unavailable" }
    > => {
        if (queuedTurn.effectiveDisposition() === SessionPromptDisposition.Steer) {
            return { disposition: SessionPromptDisposition.Steer, kind: "available" };
        }
        for (;;) {
            const first = [...this.#turns.values()].find(
                (turn) =>
                    turn.command.sessionId === command.sessionId &&
                    turn.command.disposition !== SessionPromptDisposition.Steer,
            );
            if (first === undefined || first.command.commandId === command.commandId) {
                return command.disposition !== SessionPromptDisposition.Queue ||
                    this.#operations.isTerminalExecution(command.targetCommandId, command.sessionId)
                    ? { disposition: queuedTurn.effectiveDisposition(), kind: "available" }
                    : { kind: "queue-target-unavailable" };
            }
            if (command.disposition !== SessionPromptDisposition.Queue) {
                return { kind: "busy" };
            }
            if (first.command.commandId !== command.targetCommandId) {
                return { kind: "queue-target-unavailable" };
            }
            const promotion = queuedTurn.queuePromotion();
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
