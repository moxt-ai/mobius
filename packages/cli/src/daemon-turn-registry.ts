import {
    type NativeSessionResult,
    type RecordedSessionEvent,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { ActiveDaemonTurn, type ActiveTurnRecovery } from "./daemon-active-turn.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

interface CompletedTurnRecovery {
    readonly command: SessionPromptCommand;
    readonly recovery: ActiveTurnRecovery;
}

const COMPLETED_TURN_RECOVERY_LIMIT = 32;

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
    readonly #completed = new Map<string, CompletedTurnRecovery>();
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
        const recovery = turn.recovery();
        this.#turns.delete(turn.command.commandId);
        if (recovery !== null) {
            // Agent-native history can briefly lag the terminal event. Keep the latest completed
            // Turn per Session as an in-memory overlay so every Web client sees the same complete
            // handoff. The native-history merge removes any overlapping copy, and the bounded map
            // prevents completed Sessions from growing daemon memory without limit.
            this.#completed.delete(turn.command.sessionId);
            this.#completed.set(turn.command.sessionId, {
                command: turn.command,
                recovery: { ...recovery, state: "completed" },
            });
            while (this.#completed.size > COMPLETED_TURN_RECOVERY_LIMIT) {
                const oldestSessionId = this.#completed.keys().next().value;
                if (oldestSessionId === undefined) {
                    break;
                }
                this.#completed.delete(oldestSessionId);
            }
        }
        turn.finish();
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if ("commandId" in event) {
            const turn = this.#turns.get(event.commandId);
            if (turn !== undefined && turn.command.sessionId === event.sessionId) {
                return turn.recordEvent(event);
            }
        }
        if (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
            for (const turn of this.#turns.values()) {
                if (turn.matchesInteraction(event.interactionId, event.sessionId)) {
                    return turn.recordEvent(event);
                }
            }
        }
        return event;
    };

    readonly recordSteeringPrompt = (command: SessionPromptCommand): boolean => {
        const target = this.#turns.get(command.targetCommandId);
        return target?.recordSteeringPrompt(command) ?? false;
    };

    readonly executionSnapshot = async (matches: (command: SessionPromptCommand) => Promise<boolean>) => {
        const matching: ActiveDaemonTurn[] = [];
        for (const turn of this.#turns.values()) {
            if (await matches(turn.command)) {
                matching.push(turn);
            }
        }
        const current = matching.filter((turn) => this.#turns.get(turn.command.commandId) === turn);
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

    readonly recovery = (matches: (command: SessionPromptCommand) => boolean): ActiveTurnRecovery | null => {
        for (const turn of this.#turns.values()) {
            if (!matches(turn.command)) {
                continue;
            }
            const recovery = turn.recovery();
            if (recovery !== null) {
                return recovery;
            }
        }
        for (const completed of this.#completed.values()) {
            if (matches(completed.command)) {
                return completed.recovery;
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
        this.#completed.clear();
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
            [...this.#turns.values()].find(
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
