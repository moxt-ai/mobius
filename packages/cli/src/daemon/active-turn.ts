import { randomUUID } from "node:crypto";
import {
    type AgentContentEvent,
    decodeIdentifier,
    type NativeSessionResult,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionCancelCommand,
    type SessionCommandsUpdatedEvent,
    type SessionConfigUpdatedEvent,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
    type SessionReadyEvent,
} from "@moxt-ai/mobius-sdk/protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

/** Session event kinds the daemon folds into an in-flight prompt Turn. */
export type RecordedSessionEvent =
    | AgentContentEvent
    | SessionCommandsUpdatedEvent
    | SessionConfigUpdatedEvent
    | SessionElicitationRequestedEvent
    | SessionElicitationResolvedEvent
    | SessionInfoUpdatedEvent
    | SessionPermissionRequestedEvent
    | SessionPermissionResolvedEvent
    | SessionReadyEvent;

type TurnDispatchState =
    | { readonly kind: "pending" }
    | { readonly kind: "queued"; readonly promotion: PromiseWithResolvers<void> }
    | { readonly kind: "promoted" }
    | { readonly kind: "running" };

export class ActiveDaemonTurn {
    readonly attemptId: string;
    readonly command: SessionPromptCommand;
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    #cancellationRequested = false;
    #dispatch: TurnDispatchState;
    #sequence = 0;
    #interaction: Extract<
        RecordedSessionEvent,
        { readonly kind: typeof SESSION_PERMISSION_REQUESTED_KIND | typeof SESSION_ELICITATION_REQUESTED_KIND }
    > | null = null;
    readonly #epoch = decodeIdentifier(randomUUID());

    constructor(command: SessionPromptCommand, attemptId: string) {
        this.attemptId = attemptId;
        this.command = command;
        this.#controller = new AbortController();
        this.#dispatch = { kind: "pending" };
    }

    readonly enqueue = (): void => {
        if (this.#dispatch.kind !== "pending") {
            throw new Error("Only a pending prompt can enter the queue");
        }
        this.#dispatch = { kind: "queued", promotion: Promise.withResolvers<void>() };
    };

    readonly isQueued = (): boolean => this.#dispatch.kind === "queued" && !this.#controller.signal.aborted;

    readonly abortDaemon = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => {
        this.#finished.resolve();
    };

    readonly activate = (): { readonly epoch: string; readonly sequence: 0 } => {
        this.#dispatch = { kind: "running" };
        return { epoch: this.#epoch, sequence: 0 };
    };

    readonly promoteQueuedPrompt = (command: SessionPromptDispositionCommand): boolean => {
        if (
            command.commandId !== this.command.commandId ||
            command.sessionId !== this.command.sessionId ||
            this.#dispatch.kind !== "queued"
        ) {
            return false;
        }
        const promotion = this.#dispatch.promotion;
        this.#dispatch = { kind: "promoted" };
        promotion.resolve();
        return true;
    };

    readonly queuePromotion = (): Promise<void> | null => {
        if (this.#dispatch.kind === "queued") {
            return this.#dispatch.promotion.promise;
        }
        return this.#dispatch.kind === "promoted" ? Promise.resolve() : null;
    };

    readonly effectiveDisposition = (): string =>
        this.#dispatch.kind === "promoted" ? SessionPromptDisposition.Steer : this.command.disposition;

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

    readonly recordSteeringPrompt = (command: SessionPromptCommand): boolean => {
        return (
            this.#dispatch.kind === "running" &&
            command.sessionId === this.command.sessionId &&
            command.targetCommandId === this.command.commandId
        );
    };

    readonly snapshot = (): ActiveTurnSnapshot => {
        if (this.#dispatch.kind !== "running") {
            return null;
        }
        return {
            commandId: decodeIdentifier(this.command.commandId),
            epoch: this.#epoch,
            interaction: this.#interaction,
            sequence: this.#sequence,
            state: "running",
        };
    };

    readonly matches = (cancellation: SessionCancelCommand): boolean =>
        cancellation.commandId === this.command.commandId && cancellation.sessionId === this.command.sessionId;

    readonly matchesInteraction = (interactionId: string, sessionId: string): boolean =>
        this.command.sessionId === sessionId && this.#interaction?.interactionId === interactionId;

    readonly requestCancellation = (): "already-requested" | "pending" | "running" => {
        if (this.#cancellationRequested) {
            return "already-requested";
        }
        this.#cancellationRequested = true;
        if (this.#dispatch.kind !== "running") {
            this.#controller.abort(new Error("The queued Agent turn was cancelled"));
            return "pending";
        }
        return "running";
    };

    readonly cancellationRequested = (): boolean => this.#cancellationRequested;

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}
