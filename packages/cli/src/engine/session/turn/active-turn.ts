import { randomUUID } from "node:crypto";
import {
    decodeIdentifier,
    type NativeSessionResult,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "@moxt-ai/mobius-sdk/protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

/** Interaction events the daemon folds into an in-flight prompt Turn. */
export type RecordedSessionEvent =
    | SessionElicitationRequestedEvent
    | SessionElicitationResolvedEvent
    | SessionPermissionRequestedEvent
    | SessionPermissionResolvedEvent;

/**
 * Where a prompt stands in its Session's admission. Whether it started belongs to its execution receipt: the turn
 * reads that fact instead of keeping a copy of it.
 */
type TurnAdmission =
    | { readonly kind: "waiting" }
    | { readonly kind: "queued"; readonly promotion: PromiseWithResolvers<void> }
    | { readonly kind: "promoted" }
    | { readonly kind: "admitted"; readonly disposition: string };

export type TurnCancellation =
    | { readonly kind: "already-requested" }
    | { readonly kind: "pending" }
    | { readonly kind: "running"; readonly execution: string };

export class ActiveRuntimeTurn {
    readonly attemptId: string;
    readonly command: SessionPromptCommand;
    readonly epoch = decodeIdentifier(randomUUID());
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    readonly #started: () => boolean;
    #cancellationRequested = false;
    #admission: TurnAdmission = { kind: "waiting" };
    #sequence = 0;
    #interaction: Extract<
        RecordedSessionEvent,
        { readonly kind: typeof SESSION_PERMISSION_REQUESTED_KIND | typeof SESSION_ELICITATION_REQUESTED_KIND }
    > | null = null;

    /** `started` reads the command's execution receipt, the single owner of whether the command started. */
    constructor(command: SessionPromptCommand, attemptId: string, started: () => boolean) {
        this.attemptId = attemptId;
        this.command = command;
        this.#controller = new AbortController();
        this.#started = started;
    }

    readonly enqueue = (): void => {
        if (this.#admission.kind !== "waiting") {
            throw new Error("Only a waiting prompt can enter the queue");
        }
        this.#admission = { kind: "queued", promotion: Promise.withResolvers<void>() };
    };

    /** Whether the prompt was admitted to its Session's queue, whatever happened to it afterwards. */
    readonly enteredQueue = (): boolean =>
        this.command.disposition === SessionPromptDisposition.Queue && this.#admission.kind !== "waiting";

    readonly isQueued = (): boolean =>
        (this.#admission.kind === "queued" ||
            (this.#admission.kind === "admitted" && this.#admission.disposition === SessionPromptDisposition.Queue)) &&
        !this.#started() &&
        !this.#controller.signal.aborted;

    readonly abortRuntime = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => {
        this.#finished.resolve();
    };

    readonly promoteQueuedPrompt = (
        command: SessionPromptDispositionCommand,
    ): "accepted" | "already-started" | "unavailable" => {
        if (
            command.commandId !== this.command.commandId ||
            command.sessionId !== this.command.sessionId ||
            this.#controller.signal.aborted
        ) {
            return "unavailable";
        }
        switch (this.#admission.kind) {
            case "queued": {
                const promotion = this.#admission.promotion;
                this.#admission = { kind: "promoted" };
                promotion.resolve();
                return "accepted";
            }
            case "promoted":
                return "accepted";
            case "admitted":
                return this.#admission.disposition === SessionPromptDisposition.Steer ? "accepted" : "already-started";
            case "waiting":
                return "unavailable";
        }
    };

    readonly admit = (): string => {
        const disposition = this.effectiveDisposition();
        // Claim the dispatch before asynchronous Agent preparation so a late promotion
        // cannot change a disposition that execution has already selected.
        this.#admission = { kind: "admitted", disposition };
        return disposition;
    };

    readonly queuePromotion = (): Promise<void> | null => {
        if (this.#admission.kind === "queued") {
            return this.#admission.promotion.promise;
        }
        return this.#admission.kind === "promoted" ? Promise.resolve() : null;
    };

    readonly effectiveDisposition = (): string => {
        switch (this.#admission.kind) {
            case "waiting":
            case "queued":
                return this.command.disposition;
            case "promoted":
                return SessionPromptDisposition.Steer;
            case "admitted":
                return this.#admission.disposition;
        }
    };

    /** A steering prompt joins the execution of the turn it steers; every other prompt owns its execution. */
    readonly execution = (): string =>
        this.effectiveDisposition() === SessionPromptDisposition.Steer
            ? this.command.targetCommandId
            : this.command.commandId;

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if (
            event.sessionId !== this.command.sessionId ||
            ("commandId" in event && event.commandId !== this.command.commandId)
        ) {
            return event;
        }
        if (event.kind === SESSION_PERMISSION_REQUESTED_KIND || event.kind === SESSION_ELICITATION_REQUESTED_KIND) {
            this.#interaction = event;
        } else if (
            (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) &&
            this.#interaction?.interactionId === event.interactionId
        ) {
            this.#interaction = null;
        }
        return event;
    };

    readonly snapshot = (): ActiveTurnSnapshot => {
        if (!this.#started()) {
            return null;
        }
        return {
            commandId: decodeIdentifier(this.command.commandId),
            epoch: this.epoch,
            interaction: this.#interaction,
            sequence: this.#sequence,
            state: "running",
        };
    };

    readonly matchesInteraction = (interactionId: string, sessionId: string): boolean =>
        this.command.sessionId === sessionId && this.#interaction?.interactionId === interactionId;

    /**
     * Before the command starts, cancellation withdraws it by aborting its own admission and preparation. Once it
     * started, the Agent execution it belongs to must be asked to stop.
     */
    readonly requestCancellation = (): TurnCancellation => {
        if (this.#cancellationRequested) {
            return { kind: "already-requested" };
        }
        this.#cancellationRequested = true;
        if (!this.#started()) {
            this.#controller.abort(new Error("The Agent turn was cancelled before it started"));
            return { kind: "pending" };
        }
        return { kind: "running", execution: this.execution() };
    };

    readonly cancellationRequested = (): boolean => this.#cancellationRequested;

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}
