import type { SessionStatus } from "@moxt-ai/mobius-sdk/protocol";

/**
 * Where the Session's current execution stands. `preparing`: the Session's Agent process is being readied and the
 * Agent does not hold the prompt; `started`: the Agent holds the prompt; `settled`: the Agent returned and the
 * execution is releasing the Session.
 */
type ExecutionPhase = "preparing" | "started" | "settled";

type Cancellation = { readonly kind: "none" } | { readonly kind: "requested"; readonly completion: Promise<void> };

interface Execution {
    readonly commandId: string;
    readonly phase: ExecutionPhase;
    readonly cancellation: Cancellation;
}

/**
 * The single authority for which command each Session is executing and in what phase. Every reader asks it: steering
 * joins only a started execution, the Agent process may change only while no execution holds the Session, a
 * cancellation stops only the execution it names, and the Session's working/idle status is derived from it.
 *
 * Contract: admission is the only owner of whether a Session is busy, so `begin` requires an idle Session. Each
 * transition names its command and is ignored for any other. All operations are synchronous, so a check and the
 * transition that relies on it cannot be separated by another caller.
 */
export class ActiveExecutions {
    readonly #entries = new Map<string, Execution>();
    readonly #statusChanged: (sessionId: string, status: SessionStatus) => void;

    constructor(statusChanged: (sessionId: string, status: SessionStatus) => void) {
        this.#statusChanged = statusChanged;
    }

    readonly status = (sessionId: string): SessionStatus => {
        const execution = this.#entries.get(sessionId);
        return execution === undefined ? { kind: "idle" } : { commandId: execution.commandId, kind: "working" };
    };

    readonly isBusy = (sessionId: string): boolean => this.#entries.has(sessionId);

    /** A steering prompt can join only the named execution while the Agent holds it and no one is stopping it. */
    readonly acceptsSteering = (sessionId: string, targetCommandId: string): boolean => {
        const execution = this.#entries.get(sessionId);
        return (
            execution?.commandId === targetCommandId &&
            execution.phase === "started" &&
            execution.cancellation.kind === "none"
        );
    };

    /** The command whose prompt the Session's Agent holds, if any. */
    readonly agentCommand = (sessionId: string): string | undefined => {
        const execution = this.#entries.get(sessionId);
        return execution?.phase === "started" ? execution.commandId : undefined;
    };

    readonly cancellationRequested = (sessionId: string, commandId: string): boolean => {
        const execution = this.#entries.get(sessionId);
        return execution?.commandId === commandId && execution.cancellation.kind === "requested";
    };

    readonly cancellation = (sessionId: string): Promise<void> | undefined => {
        const cancellation = this.#entries.get(sessionId)?.cancellation;
        return cancellation?.kind === "requested" ? cancellation.completion : undefined;
    };

    readonly begin = (sessionId: string, commandId: string): void => {
        if (this.#entries.has(sessionId)) {
            throw new Error("A Session executes one command at a time");
        }
        this.#entries.set(sessionId, { commandId, phase: "preparing", cancellation: { kind: "none" } });
        this.#statusChanged(sessionId, this.status(sessionId));
    };

    /** The Agent receives the prompt. A cancelled execution must not start. */
    readonly start = (sessionId: string, commandId: string): void => {
        const execution = this.#entries.get(sessionId);
        if (execution?.commandId !== commandId || execution.phase !== "preparing") {
            throw new Error("Only the Session's preparing execution can start");
        }
        if (execution.cancellation.kind !== "none") {
            throw new Error("A cancelled execution cannot start");
        }
        this.#entries.set(sessionId, { ...execution, phase: "started" });
    };

    readonly settle = (sessionId: string, commandId: string): void => {
        const execution = this.#entries.get(sessionId);
        if (execution?.commandId === commandId) {
            this.#entries.set(sessionId, { ...execution, phase: "settled" });
        }
    };

    /**
     * Records a cancellation of the named execution and asks `stop` to end it once. Another command's cancellation,
     * or one for an idle Session, has nothing to stop. A cancelled execution that has not started never starts.
     */
    readonly cancel = (sessionId: string, commandId: string, stop: () => Promise<void>): Promise<void> => {
        const execution = this.#entries.get(sessionId);
        if (execution?.commandId !== commandId) {
            return Promise.resolve();
        }
        if (execution.cancellation.kind === "requested") {
            return execution.cancellation.completion;
        }
        const completion = Promise.withResolvers<void>();
        this.#entries.set(sessionId, {
            ...execution,
            cancellation: { kind: "requested", completion: completion.promise },
        });
        void (async () => await stop())().then(completion.resolve, completion.reject);
        return completion.promise;
    };

    readonly finish = (sessionId: string, commandId: string): void => {
        if (this.#entries.get(sessionId)?.commandId !== commandId) {
            return;
        }
        this.#entries.delete(sessionId);
        this.#statusChanged(sessionId, this.status(sessionId));
    };
}
