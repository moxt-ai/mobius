import { randomUUID } from "node:crypto";
import {
    ACTIVE_TURN_TEXT_LIMIT,
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_CONTENT_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentDisplayContent,
    type AgentMessageDeltaEvent,
    decodeIdentifier,
    type NativeMessageActivity,
    type NativeSessionResult,
    type RecordedSessionEvent,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionCancelCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "@moxt-ai/mobius-protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];
type ActiveTurnEventInput =
    | {
          readonly kind: typeof AGENT_MESSAGE_DELTA_KIND;
          readonly messageId: string;
          readonly text: string;
      }
    | Exclude<RecordedSessionEvent, AgentMessageDeltaEvent>;

type TurnDispatchState =
    | { readonly kind: "pending" }
    | { readonly kind: "queued"; readonly promotion: PromiseWithResolvers<void> }
    | { readonly kind: "promoted" }
    | { readonly kind: "accepted" };

export class ActiveDaemonTurn {
    readonly attemptId: string;
    readonly command: SessionPromptCommand;
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    #cancellationRequested = false;
    #dispatch: TurnDispatchState;
    #text = "";
    readonly #activities = new Map<string, NativeMessageActivity>();
    readonly #content = new Map<string, AgentDisplayContent>();
    #truncated = false;
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
        this.#dispatch =
            command.disposition === SessionPromptDisposition.Queue
                ? { kind: "queued", promotion: Promise.withResolvers<void>() }
                : { kind: "pending" };
    }

    readonly isQueued = (): boolean => this.#dispatch.kind === "queued" && !this.#controller.signal.aborted;

    readonly abortDaemon = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => this.#finished.resolve();

    readonly accept = (): { readonly epoch: string; readonly sequence: 0 } => {
        this.#dispatch = { kind: "accepted" };
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

    readonly recordEvent = (event: ActiveTurnEventInput): RecordedSessionEvent => {
        if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
            this.#sequence += 1;
            this.#text += event.text;
            if (this.#text.length > ACTIVE_TURN_TEXT_LIMIT) {
                this.#text = this.#text.slice(-ACTIVE_TURN_TEXT_LIMIT);
                this.#truncated = true;
            }
            return {
                commandId: this.command.commandId,
                epoch: this.#epoch,
                kind: AGENT_MESSAGE_DELTA_KIND,
                messageId: event.messageId,
                sequence: this.#sequence,
                sessionId: this.command.sessionId,
                text: event.text,
            };
        }
        if (
            event.sessionId !== this.command.sessionId ||
            ("commandId" in event && event.commandId !== this.command.commandId)
        ) {
            return event;
        }
        if (event.kind === AGENT_ACTIVITY_KIND) {
            this.#activities.set(event.activityId, {
                activityId: event.activityId,
                activityType: event.activityType,
                content: event.content,
                input: event.input,
                locations: event.locations,
                name: event.name,
                output: event.output,
                sequence: event.sequence,
                status: event.status,
                title: event.title,
                toolKind: event.toolKind,
            });
        } else if (event.kind === AGENT_ACTIVITY_NARRATION_KIND) {
            const previous = this.#activities.get(event.activityId);
            this.#activities.set(event.activityId, {
                activityId: event.activityId,
                activityType: event.activityType,
                content: previous?.content ?? [],
                input: previous?.input ?? "",
                locations: previous?.locations ?? [],
                name: previous?.name ?? "",
                output: `${previous?.output ?? ""}${event.text}`,
                sequence: event.sequence,
                status: previous?.status ?? "running",
                title: previous?.title ?? "Thinking",
                toolKind: previous?.toolKind ?? "",
            });
        } else if (event.kind === AGENT_CONTENT_KIND) {
            this.#content.set(event.contentId, event.content);
        } else if (
            event.kind === SESSION_PERMISSION_REQUESTED_KIND ||
            event.kind === SESSION_ELICITATION_REQUESTED_KIND
        ) {
            this.#interaction = event;
        } else if (
            (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) &&
            this.#interaction?.interactionId === event.interactionId
        ) {
            this.#interaction = null;
        }
        return event;
    };

    readonly snapshot = (): ActiveTurnSnapshot =>
        this.#dispatch.kind === "accepted"
            ? {
                  activities: [...this.#activities.values()].sort((left, right) => left.sequence - right.sequence),
                  commandId: decodeIdentifier(this.command.commandId),
                  content: [...this.#content.values()],
                  prompt: this.command.prompt,
                  text: this.#text,
                  truncated: this.#truncated,
                  epoch: this.#epoch,
                  interaction: this.#interaction,
                  sequence: this.#sequence,
                  state: "running",
              }
            : null;

    readonly matches = (cancellation: SessionCancelCommand): boolean =>
        cancellation.commandId === this.command.commandId && cancellation.sessionId === this.command.sessionId;

    readonly requestCancellation = (): "already-requested" | "pending" | "running" => {
        if (this.#cancellationRequested) {
            return "already-requested";
        }
        this.#cancellationRequested = true;
        if (this.#dispatch.kind !== "accepted") {
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
