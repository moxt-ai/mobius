import type { NativeSessionResult, SessionLiveEvent, SessionPromptCommand } from "@moxt-ai/mobius-sdk/protocol";
import type { ActiveRuntimeTurn, RecordedSessionEvent } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";
import { RuntimeTurnActivity } from "./runtime-turn-activity.ts";
import type { SessionAdmission } from "./session-execution.ts";
import { SessionExecutionState } from "./session-execution.ts";

type QueuedTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["queued"];

/** Runtime-owned index over per-session execution state; owns no session state itself. */
export class SessionTurns {
    readonly #bySessionId = new Map<string, SessionExecutionState>();
    readonly #operations: ExecutionReceipts;
    readonly #activity: RuntimeTurnActivity;

    constructor(operations: ExecutionReceipts, activity = new RuntimeTurnActivity()) {
        this.#operations = operations;
        this.#activity = activity;
    }

    readonly acceptsPrompts = (): boolean => this.#activity.acceptsPrompts();

    readonly session = (sessionId: string): SessionExecutionState => {
        let session = this.#bySessionId.get(sessionId);
        if (session === undefined) {
            session = new SessionExecutionState(sessionId, this.#operations);
            this.#bySessionId.set(sessionId, session);
        }
        return session;
    };

    readonly get = (commandId: string, sessionId: string): ActiveRuntimeTurn | undefined =>
        this.#bySessionId.get(sessionId)?.get(commandId);

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveRuntimeTurn => {
        const turn = this.session(command.sessionId).start(command, attemptId);
        this.#activity.start(turn);
        return turn;
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#bySessionId.get(turn.command.sessionId)?.finish(turn);
        this.sweep();
        this.#activity.finish(turn);
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent =>
        "sessionId" in event ? (this.#bySessionId.get(event.sessionId)?.recordEvent(event) ?? event) : event;

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

    readonly recordSteeringPrompt = (command: SessionPromptCommand): boolean =>
        this.#bySessionId.get(command.sessionId)?.recordSteeringPrompt(command) ?? false;

    readonly executionSnapshot = async (matches: (command: SessionPromptCommand) => Promise<boolean>) => {
        for (const session of this.#bySessionId.values()) {
            const matching: ActiveRuntimeTurn[] = [];
            for (const turn of session.turns()) {
                if (await matches(turn.command)) {
                    matching.push(turn);
                }
            }
            // The snapshot reports the first matching running turn; candidates that
            // settled during the asynchronous match are excluded, and queued entries
            // must each match the caller's execution identity: a sessionId alone
            // does not establish agent or directory equality.
            const current = matching.filter(
                (turn) => this.get(turn.command.commandId, turn.command.sessionId) === turn,
            );
            const turnSnapshot = current.map((turn) => turn.snapshot()).find((snapshot) => snapshot !== null);
            if (turnSnapshot === undefined && current.length === 0) {
                continue;
            }
            const queued: QueuedTurnSnapshot[number][] = [];
            for (const candidate of current) {
                if (!candidate.isQueued()) {
                    continue;
                }
                queued.push({
                    commandId: candidate.command.commandId,
                    prompt: candidate.command.prompt,
                    images: candidate.command.images,
                });
            }
            return { turn: turnSnapshot ?? null, queued };
        }
        return { turn: null, queued: [] };
    };

    readonly admitAndWait = async (
        turn: ActiveRuntimeTurn,
        waitSignal: AbortSignal,
        onQueued: () => void,
    ): Promise<SessionAdmission> => this.session(turn.command.sessionId).admitAndWait(turn, waitSignal, onQueued);

    /** Discards empty session states so the index does not grow unboundedly. */
    readonly sweep = (): void => {
        for (const [sessionId, session] of this.#bySessionId) {
            if (session.isEmpty()) {
                this.#bySessionId.delete(sessionId);
            }
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#bySessionId.values()].map((session) => session.close()));
    };
}
