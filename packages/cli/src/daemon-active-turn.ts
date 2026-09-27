import { randomUUID } from "node:crypto";
import {
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
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_MESSAGE_LIMIT,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionCancelCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "@moxt-ai/mobius-protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];
type ActiveTurnMessage = NonNullable<ActiveTurnSnapshot>["messages"][number];
type ActiveTurnEventInput =
    | {
          readonly kind: typeof AGENT_MESSAGE_DELTA_KIND;
          readonly messageId: string;
          readonly text: string;
      }
    | Exclude<RecordedSessionEvent, AgentMessageDeltaEvent>;

type ActiveTimelineEntry =
    | {
          readonly kind: "message";
          readonly id: string;
          readonly sourceMessageId: string;
          readonly text: string;
          readonly content: ReadonlyMap<string, AgentDisplayContent>;
      }
    | { readonly kind: "activity"; readonly activityId: string; readonly id: string }
    | {
          readonly kind: "user";
          readonly id: string;
          readonly images: SessionPromptCommand["images"];
          readonly text: string;
      };

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
    #text = "";
    readonly #activities = new Map<string, NativeMessageActivity>();
    readonly #content = new Map<string, AgentDisplayContent>();
    #timeline: readonly ActiveTimelineEntry[];
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
        this.#timeline = [
            { id: decodeIdentifier(command.commandId), images: command.images, kind: "user", text: command.prompt },
        ];
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

    readonly finish = (): void => this.#finished.resolve();

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

    readonly recordEvent = (event: ActiveTurnEventInput): RecordedSessionEvent => {
        if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
            this.#text += event.text;
            this.appendMessageText(event.messageId, event.text);
            return this.updated();
        }
        if (
            event.sessionId !== this.command.sessionId ||
            ("commandId" in event && event.commandId !== this.command.commandId)
        ) {
            return event;
        }
        if (event.kind === AGENT_ACTIVITY_KIND) {
            if (!this.#activities.has(event.activityId)) {
                this.#timeline = [
                    ...this.#timeline,
                    { activityId: event.activityId, id: decodeIdentifier(randomUUID()), kind: "activity" },
                ];
            }
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
            if (previous === undefined) {
                this.#timeline = [
                    ...this.#timeline,
                    { activityId: event.activityId, id: decodeIdentifier(randomUUID()), kind: "activity" },
                ];
            }
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
            const target = this.#timeline.findLastIndex(
                (entry) => entry.kind === "message" && entry.sourceMessageId === event.messageId,
            );
            if (target < 0) {
                this.#timeline = [
                    ...this.#timeline,
                    {
                        content: new Map([[event.contentId, event.content]]),
                        id: decodeIdentifier(randomUUID()),
                        kind: "message",
                        sourceMessageId: event.messageId,
                        text: "",
                    },
                ];
            } else {
                this.#timeline = this.#timeline.map((entry, index) =>
                    index === target && entry.kind === "message"
                        ? { ...entry, content: new Map([...entry.content, [event.contentId, event.content]]) }
                        : entry,
                );
            }
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
        if (
            event.kind === AGENT_ACTIVITY_KIND ||
            event.kind === AGENT_ACTIVITY_NARRATION_KIND ||
            event.kind === AGENT_CONTENT_KIND
        ) {
            return this.updated();
        }
        return event;
    };

    private appendMessageText(messageId: string, text: string): void {
        let remaining = text;
        while (remaining.length > 0) {
            const latest = this.#timeline.at(-1);
            if (latest?.kind === "message" && latest.sourceMessageId === messageId) {
                const available = SESSION_HISTORY_CHARACTER_LIMIT - latest.text.length;
                if (available > 0) {
                    this.#timeline = [
                        ...this.#timeline.slice(0, -1),
                        { ...latest, text: `${latest.text}${remaining.slice(0, available)}` },
                    ];
                    remaining = remaining.slice(available);
                    continue;
                }
            }
            this.#timeline = [
                ...this.#timeline,
                {
                    content: new Map(),
                    id: decodeIdentifier(randomUUID()),
                    kind: "message",
                    sourceMessageId: messageId,
                    text: remaining.slice(0, SESSION_HISTORY_CHARACTER_LIMIT),
                },
            ];
            remaining = remaining.slice(SESSION_HISTORY_CHARACTER_LIMIT);
        }
    }

    readonly recordSteeringPrompt = (command: SessionPromptCommand): RecordedSessionEvent | null => {
        if (
            this.#dispatch.kind !== "running" ||
            command.sessionId !== this.command.sessionId ||
            command.targetCommandId !== this.command.commandId
        ) {
            return null;
        }
        this.#timeline = [
            ...this.#timeline,
            { id: decodeIdentifier(command.commandId), images: command.images, kind: "user", text: command.prompt },
        ];
        return this.updated();
    };

    private timelineMessages(): readonly ActiveTurnMessage[] {
        return this.#timeline.flatMap((entry): readonly ActiveTurnMessage[] => {
            if (entry.kind === "user") {
                return [{ id: entry.id, images: entry.images, role: "user", text: entry.text }];
            }
            if (entry.kind === "message") {
                return [
                    {
                        activities: [],
                        content: [...entry.content.values()],
                        id: entry.id,
                        role: "assistant",
                        text: entry.text,
                    },
                ];
            }
            const activity = this.#activities.get(entry.activityId);
            return activity === undefined
                ? []
                : [{ activities: [activity], content: [], id: entry.id, role: "assistant", text: "" }];
        });
    }

    private readonly updated = (): RecordedSessionEvent => {
        this.#sequence += 1;
        const turn = this.snapshot();
        if (turn === null) {
            throw new Error("Only a running turn can publish a snapshot");
        }
        return { kind: "session.turn.updated", sessionId: this.command.sessionId, turn };
    };

    readonly snapshot = (): ActiveTurnSnapshot => {
        if (this.#dispatch.kind !== "running") {
            return null;
        }
        const completeMessages = this.timelineMessages();
        const messages = completeMessages.slice(-SESSION_HISTORY_MESSAGE_LIMIT);
        return {
            activities: [...this.#activities.values()].sort((left, right) => left.sequence - right.sequence),
            commandId: decodeIdentifier(this.command.commandId),
            content: [...this.#content.values()],
            prompt: this.command.prompt,
            text: this.#text,
            truncated: messages.length !== completeMessages.length,
            epoch: this.#epoch,
            interaction: this.#interaction,
            messages,
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
