import type {
    AgentContentEvent,
    NativeSessionHistory,
    PromptImage,
    PromptResource,
    SessionCapabilities,
    SessionCommand,
    SessionConfigOption,
    SessionContextUsageUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionPermissionRequestedEvent,
    SessionPromptUsageUpdatedEvent,
    SessionReadyEvent,
    SessionUsageUpdatedEvent,
    WorkspaceEntry,
} from "@moxt-ai/mobius-sdk";
import { conversationTitleFromText, SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import {
    type AgentOption,
    CompletedRecordedTurn,
    FailedRecordedTurn,
    PendingRecordedTurn,
    type RecordedActivity,
    type RecordedContent,
    type RecordedSession,
    type RecordedTurn,
    RunningRecordedTurn,
    type TurnTiming,
    UNTIMED_TURN,
} from "@/domain/channel";

const EMPTY_CAPABILITIES: SessionCapabilities = {
    additionalDirectories: false,
    audioPrompt: false,
    closeSession: false,
    deleteSession: false,
    embeddedContextPrompt: false,
    imagePrompt: false,
    listSessions: false,
    loadSession: false,
    promptQueueing: false,
    resumeSession: false,
    steering: false,
    unstableForkSession: false,
};

function restoreAdditionalDirectories(
    directoryIds: readonly string[],
    existing: readonly WorkspaceEntry[] = [],
): readonly WorkspaceEntry[] {
    return directoryIds.map((directoryId) => {
        const current = existing.find((directory) => directory.directoryId === directoryId);
        return current ?? { directoryId, name: directoryId };
    });
}

function directoryLabelFromId(directoryId: string): string {
    if (directoryId === "default") {
        return "Default workspace";
    }
    if (directoryId === "home") {
        return "~";
    }
    if (!directoryId.startsWith("path-")) {
        return directoryId;
    }
    try {
        const base64 = directoryId.slice("path-".length).replaceAll("-", "+").replaceAll("_", "/");
        return decodeURIComponent(escape(atob(base64)));
    } catch {
        return directoryId;
    }
}

export abstract class SessionUsageState {
    abstract readonly available: boolean;
    abstract readonly context: SessionContextUsageUpdatedEvent | null;
    abstract readonly costLabel: string;
    abstract readonly details: readonly {
        readonly label: string;
        readonly value: string;
    }[];
    abstract readonly percent: number;
    abstract readonly prompt: SessionPromptUsageUpdatedEvent | null;
    abstract readonly size: number;
    abstract readonly summary: string;
    abstract readonly used: number;

    readonly withUpdate = (event: SessionUsageUpdatedEvent): SessionUsageState => new MeasuredSessionUsage(event, this);
}

class UnknownSessionUsage extends SessionUsageState {
    readonly available = false;
    readonly context = null;
    readonly costLabel = "";
    readonly details = [];
    readonly percent = 0;
    readonly prompt = null;
    readonly size = 0;
    readonly summary = "Context usage unavailable";
    readonly used = 0;
}

class MeasuredSessionUsage extends SessionUsageState {
    readonly available = true;
    readonly context: SessionContextUsageUpdatedEvent | null;
    readonly costLabel: string;
    readonly details: readonly {
        readonly label: string;
        readonly value: string;
    }[];
    readonly percent: number;
    readonly prompt: SessionPromptUsageUpdatedEvent | null;
    readonly size: number;
    readonly summary: string;
    readonly used: number;

    constructor(event: SessionUsageUpdatedEvent, previous: SessionUsageState) {
        super();
        switch (event.source) {
            case "context":
                this.context = event;
                this.prompt = previous.prompt;
                break;
            case "prompt":
                this.context = previous.context;
                this.prompt = event;
                break;
            default: {
                const unhandled: never = event;
                throw new Error(`Unknown usage source: ${String(unhandled)}`);
            }
        }
        const context = this.context;
        this.size = context?.size ?? 0;
        this.used = context?.used ?? 0;
        this.percent = this.size === 0 ? 0 : Math.min(100, Math.round((this.used / this.size) * 100));
        this.summary =
            context === null
                ? "Context usage unavailable"
                : `${formatCompactNumber(this.used)} / ${formatCompactNumber(this.size)} tokens`;
        if (!context?.hasCost) {
            this.costLabel = "";
        } else if (context.costCurrency.toUpperCase() === "USD") {
            this.costLabel = `$${context.costAmount.toFixed(2)} ${context.costCurrency}`;
        } else {
            this.costLabel = `${context.costAmount.toFixed(2)} ${context.costCurrency}`;
        }
        const details: { readonly label: string; readonly value: string }[] = [];
        const usage = this.prompt?.usage;
        if (usage != null) {
            for (const [label, value] of [
                ["Reported tokens", usage.totalTokens],
                ["Input", usage.inputTokens],
                ["Output", usage.outputTokens],
                ["Cache read", usage.cachedReadTokens],
                ["Cache write", usage.cachedWriteTokens],
                ["Reasoning", usage.thoughtTokens],
            ] satisfies readonly (readonly [string, number | null | undefined])[]) {
                if (value != null) {
                    details.push({ label, value: value.toLocaleString("en-US") });
                }
            }
        }
        const quota = this.prompt?._meta?.quota;
        if (quota !== undefined) {
            if (quota.token_count !== null) {
                details.push({
                    label: "Agent quota tokens",
                    value: quota.token_count.totalTokens.toLocaleString("en-US"),
                });
            }
            for (const model of quota.model_usage) {
                details.push({
                    label: model.model,
                    value: model.token_count.totalTokens.toLocaleString("en-US"),
                });
            }
        }
        this.details = details;
    }
}

export abstract class AgentSessionState {
    abstract readonly autoPrepare: boolean;
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly elicitations: readonly SessionElicitationRequestedEvent[];
    abstract readonly isPreparing: boolean;
    abstract readonly isReady: boolean;
    abstract readonly label: string;
    abstract readonly updatedAt: string;
    readonly permissions: readonly SessionPermissionRequestedEvent[];
    readonly restored: boolean;
    readonly usage: SessionUsageState;
    abstract readonly withInteractions: (
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
    ) => AgentSessionState;

    protected constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
        restored: boolean,
        usage: SessionUsageState,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.elicitations = elicitations;
        this.permissions = permissions;
        this.restored = restored;
        this.usage = usage;
    }
}

class UnpreparedSessionState extends AgentSessionState {
    readonly autoPrepare = true;
    readonly isPreparing = false;
    readonly isReady = false;
    readonly label = "Agent settings not loaded";
    readonly updatedAt = "";

    constructor(
        elicitations: readonly SessionElicitationRequestedEvent[] = [],
        permissions: readonly SessionPermissionRequestedEvent[] = [],
    ) {
        super("", "", EMPTY_CAPABILITIES, [], [], elicitations, permissions, false, new UnknownSessionUsage());
    }

    readonly withInteractions = (
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
    ): UnpreparedSessionState => new UnpreparedSessionState(elicitations, permissions);
}

class PreparingSessionState extends AgentSessionState {
    readonly autoPrepare = false;
    readonly isPreparing = true;
    readonly isReady = false;
    readonly label = "Loading agent settings";
    readonly updatedAt = "";

    constructor(
        elicitations: readonly SessionElicitationRequestedEvent[] = [],
        permissions: readonly SessionPermissionRequestedEvent[] = [],
    ) {
        super("", "", EMPTY_CAPABILITIES, [], [], elicitations, permissions, false, new UnknownSessionUsage());
    }

    readonly withInteractions = (
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
    ): PreparingSessionState => new PreparingSessionState(elicitations, permissions);
}

export class SessionPreparationFailedState extends AgentSessionState {
    readonly autoPrepare = false;
    readonly error: string;
    readonly isPreparing = false;
    readonly isReady = false;
    readonly label = "Agent settings unavailable";
    readonly updatedAt = "";

    constructor(
        error: string,
        elicitations: readonly SessionElicitationRequestedEvent[] = [],
        permissions: readonly SessionPermissionRequestedEvent[] = [],
    ) {
        super("", "", EMPTY_CAPABILITIES, [], [], elicitations, permissions, false, new UnknownSessionUsage());
        this.error = error;
    }

    readonly withInteractions = (
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
    ): SessionPreparationFailedState => new SessionPreparationFailedState(this.error, elicitations, permissions);
}

export class DeletedSessionState extends AgentSessionState {
    readonly autoPrepare = false;
    readonly isPreparing = false;
    readonly isReady = false;
    readonly label = "Native session deleted";
    readonly updatedAt = "";

    constructor() {
        super("", "", EMPTY_CAPABILITIES, [], [], [], [], true, new UnknownSessionUsage());
    }

    readonly withInteractions = (): DeletedSessionState => this;
}

export class ReadySessionState extends AgentSessionState {
    readonly autoPrepare = false;
    readonly isPreparing = false;
    readonly isReady = true;
    readonly label = "Agent ready";
    readonly updatedAt: string;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
        restored: boolean,
        usage: SessionUsageState,
        updatedAt: string,
    ) {
        super(
            agentName,
            agentVersion,
            capabilities,
            commands,
            configOptions,
            elicitations,
            permissions,
            restored,
            usage,
        );
        this.updatedAt = updatedAt;
    }

    static fromReady(event: SessionReadyEvent): ReadySessionState {
        return new ReadySessionState(
            event.agentName,
            event.agentVersion,
            event.capabilities,
            event.commands,
            event.configOptions,
            [],
            [],
            event.restored,
            new UnknownSessionUsage(),
            "",
        );
    }

    readonly withCommands = (commands: readonly SessionCommand[]): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            commands,
            this.configOptions,
            this.elicitations,
            this.permissions,
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withConfig = (configOptions: readonly SessionConfigOption[]): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            configOptions,
            this.elicitations,
            this.permissions,
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withInteractions = (
        elicitations: readonly SessionElicitationRequestedEvent[],
        permissions: readonly SessionPermissionRequestedEvent[],
    ): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            elicitations,
            permissions,
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withElicitation = (elicitation: SessionElicitationRequestedEvent): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            [
                ...this.elicitations.filter((candidate) => candidate.interactionId !== elicitation.interactionId),
                elicitation,
            ],
            this.permissions,
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withPermission = (permission: SessionPermissionRequestedEvent): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            this.elicitations,
            [
                ...this.permissions.filter((candidate) => candidate.interactionId !== permission.interactionId),
                permission,
            ],
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withUsage = (usage: SessionUsageUpdatedEvent): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            this.elicitations,
            this.permissions,
            this.restored,
            this.usage.withUpdate(usage),
            this.updatedAt,
        );

    readonly withoutElicitation = (interactionId: string): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            this.elicitations.filter((candidate) => candidate.interactionId !== interactionId),
            this.permissions,
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly resolveElicitation = (event: SessionElicitationResolvedEvent): ReadySessionState => {
        const elicitation = this.elicitations.find((entry) => entry.interactionId === event.interactionId);
        if (event.action !== "accept" || elicitation === undefined || elicitation.mode !== "url") {
            return this.withoutElicitation(event.interactionId);
        }
        return this.withElicitation({ ...elicitation, accepted: true });
    };

    readonly withoutPermission = (interactionId: string): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            this.elicitations,
            this.permissions.filter((candidate) => candidate.interactionId !== interactionId),
            this.restored,
            this.usage,
            this.updatedAt,
        );

    readonly withUpdatedAt = (updatedAt: string): ReadySessionState =>
        new ReadySessionState(
            this.agentName,
            this.agentVersion,
            this.capabilities,
            this.commands,
            this.configOptions,
            this.elicitations,
            this.permissions,
            this.restored,
            this.usage,
            updatedAt,
        );
}

export interface RunDetail {
    readonly label: string;
    readonly value: string;
}

export type RuntimeConnectionAppearance = "connecting" | "offline" | "online" | "unavailable";

export abstract class RuntimeConnectionState {
    abstract readonly appearance: RuntimeConnectionAppearance;
    abstract readonly canSend: boolean;
    abstract readonly description: string;
    abstract readonly label: string;
}

export class ConnectingRuntimeState extends RuntimeConnectionState {
    readonly appearance = "connecting";
    readonly canSend = false;
    readonly description = "Connecting to the local runtime…";
    readonly label = "Connecting";
}

export class ReconnectingRuntimeState extends RuntimeConnectionState {
    readonly appearance = "connecting";
    readonly canSend = false;
    readonly description = "Reconnecting the browser to the Mobius relay…";
    readonly label = "Reconnecting";
}

export class OnlineRuntimeState extends RuntimeConnectionState {
    readonly appearance = "online";
    readonly canSend = true;
    readonly description = "Connected through the local Mobius relay";
    readonly label = "Runtime online";
}

export class OfflineRuntimeState extends RuntimeConnectionState {
    readonly appearance = "offline";
    readonly canSend = false;
    readonly description = "The local runtime is offline. Messages cannot be sent yet.";
    readonly label = "Runtime offline";
}

export class UnavailableRuntimeState extends RuntimeConnectionState {
    readonly appearance = "unavailable";
    readonly canSend = false;
    readonly description = "The relay is unavailable. Start the local stack, then reload this page.";
    readonly label = "Relay unavailable";
}

export abstract class AgentTurnState {
    abstract readonly appearance: string;
    abstract readonly canStop: boolean;
    abstract readonly isStreaming: boolean;
    abstract readonly label: string;
    abstract readonly progress: number;
    /** True once the Turn reached a terminal outcome and its elapsed time can be measured. */
    abstract readonly settled: boolean;
    abstract readonly details: (sessionId: string) => readonly RunDetail[];
    abstract readonly stop: () => AgentTurnState;
}

class AuthorizingTurnState extends AgentTurnState {
    readonly appearance = "working";
    readonly canStop = true;
    readonly isStreaming = true;
    readonly label = "Authorizing";
    readonly progress = 0;
    readonly settled = false;
    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "State", value: "Checking local workspace access" },
    ];
    readonly stop = (): AgentTurnState => new StoppingTurnState("Pending");
}

class PendingTurnState extends AgentTurnState {
    readonly appearance = "working";
    readonly canStop = true;
    readonly isStreaming = true;
    readonly label = "Pending";
    readonly progress = 0;
    readonly settled = false;
    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "State", value: "Waiting for the local runtime" },
    ];
    readonly stop = (): AgentTurnState => new StoppingTurnState("Pending");
}

class QueuedTurnState extends AgentTurnState {
    readonly appearance = "queued";
    readonly canStop = false;
    readonly isStreaming = false;
    readonly label = "Queued";
    readonly progress = 0;
    readonly settled = false;
    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "State", value: "Waiting for the current turn to finish" },
    ];
    readonly stop = (): AgentTurnState => this;
}

export class RunningTurnState extends AgentTurnState {
    readonly appearance = "working";
    readonly canStop = true;
    readonly isStreaming = true;
    readonly label = "Working";
    readonly progress = 1;
    readonly settled = false;
    readonly #attemptId: string;

    constructor(attemptId: string) {
        super();
        this.#attemptId = attemptId;
    }

    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "Attempt", value: this.#attemptId },
        { label: "State", value: "Streaming agent response" },
    ];
    readonly stop = (): AgentTurnState => new StoppingTurnState(this.#attemptId);
}

export class StoppingTurnState extends AgentTurnState {
    readonly appearance = "working";
    readonly canStop = false;
    readonly isStreaming = true;
    readonly label = "Stopping";
    readonly progress = 1.5;
    readonly settled = false;
    readonly #attemptId: string;

    constructor(attemptId: string) {
        super();
        this.#attemptId = attemptId;
    }

    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "Attempt", value: this.#attemptId },
        { label: "State", value: "Waiting for the local agent to stop" },
    ];

    readonly stop = (): AgentTurnState => this;

    readonly withAttemptId = (attemptId: string): StoppingTurnState => new StoppingTurnState(attemptId);
}

export class CompletedTurnState extends AgentTurnState {
    readonly appearance = "completed";
    readonly canStop = false;
    readonly isStreaming = false;
    readonly label = "Completed";
    readonly progress = 2;
    readonly settled = true;
    readonly #attemptId: string;
    readonly #stopReason: string;

    constructor(attemptId: string, stopReason: string) {
        super();
        this.#attemptId = attemptId;
        this.#stopReason = stopReason;
    }

    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "Attempt", value: this.#attemptId },
        { label: "Stop reason", value: this.#stopReason },
    ];
    readonly stop = (): AgentTurnState => this;
}

export class StoppedTurnState extends AgentTurnState {
    readonly appearance = "stopped";
    readonly canStop = false;
    readonly isStreaming = false;
    readonly label = "Stopped";
    readonly progress = 2;
    readonly settled = true;
    readonly #attemptId: string;

    constructor(attemptId: string) {
        super();
        this.#attemptId = attemptId;
    }

    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "Attempt", value: this.#attemptId },
        { label: "Stop reason", value: "cancelled" },
    ];
    readonly stop = (): AgentTurnState => this;
}

export class FailedTurnState extends AgentTurnState {
    readonly appearance = "failed";
    readonly canStop = false;
    readonly isStreaming = false;
    readonly label = "Failed";
    readonly progress = 2;
    readonly settled = true;
    readonly #message: string;

    constructor(message: string) {
        super();
        this.#message = message;
    }

    readonly details = (sessionId: string): readonly RunDetail[] => [
        { label: "Session", value: sessionId },
        { label: "Error", value: this.#message },
    ];
    readonly stop = (): AgentTurnState => this;
}

export abstract class ChatMessage {
    readonly createdAt: Date;
    readonly id: string;

    protected constructor(id: string, createdAt: Date) {
        this.id = id;
        this.createdAt = createdAt;
    }
}

export class NativeHistoryChatMessage extends ChatMessage {
    readonly history: NativeSessionHistory;

    constructor(sessionId: string, history: NativeSessionHistory) {
        // ACP replay has no reliable message timestamps. History is ordered before live turns.
        super(`${sessionId}:native-history`, new Date(0));
        this.history = history;
    }
}

function mergeNativeHistory(
    sessionId: string,
    history: NativeSessionHistory | null,
    messages: readonly ChatMessage[],
): readonly ChatMessage[] {
    if (history === null) {
        return messages;
    }
    const covered = new Set(
        history.status === "available"
            ? [
                  ...history.coveredCommandIds.flatMap((id) => [`${id}:user`, `${id}:agent`]),
                  ...history.coveredMessageIds,
              ]
            : [],
    );
    return [
        new NativeHistoryChatMessage(sessionId, history),
        ...messages.filter((message) => !(message instanceof NativeHistoryChatMessage) && !covered.has(message.id)),
    ];
}

export abstract class UserChatMessage extends ChatMessage {
    readonly commandId: string;
    abstract readonly disposition: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    abstract readonly targetCommandId: string;
    readonly text: string;

    constructor(
        commandId: string,
        createdAt: Date,
        text: string,
        images: readonly PromptImage[] = [],
        resources: readonly PromptResource[] = [],
    ) {
        super(`${commandId}:user`, createdAt);
        this.commandId = commandId;
        this.images = images;
        this.resources = resources;
        this.text = text;
    }

    static create(
        commandId: string,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
    ): UserChatMessage {
        return new ImmediateUserChatMessage(commandId, new Date(), text, images, resources);
    }

    static createQueued(
        commandId: string,
        targetCommandId: string,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
    ): UserChatMessage {
        return new QueuedUserChatMessage(commandId, new Date(), text, images, resources, targetCommandId);
    }

    static createSteering(
        commandId: string,
        targetCommandId: string,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
    ): UserChatMessage {
        return new SteeringUserChatMessage(commandId, new Date(), text, images, resources, targetCommandId);
    }
}

export class ImmediateUserChatMessage extends UserChatMessage {
    readonly disposition = SessionPromptDisposition.Reject;
    readonly targetCommandId = "";
}

export class QueuedUserChatMessage extends UserChatMessage {
    readonly disposition = SessionPromptDisposition.Queue;
    readonly targetCommandId: string;

    constructor(
        commandId: string,
        createdAt: Date,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        targetCommandId: string,
    ) {
        super(commandId, createdAt, text, images, resources);
        this.targetCommandId = targetCommandId;
    }

    readonly asSteering = (): SteeringUserChatMessage =>
        new SteeringUserChatMessage(
            this.commandId,
            this.createdAt,
            this.text,
            this.images,
            this.resources,
            this.targetCommandId,
        );
}

export class SteeringUserChatMessage extends UserChatMessage {
    readonly disposition = SessionPromptDisposition.Steer;
    readonly targetCommandId: string;

    constructor(
        commandId: string,
        createdAt: Date,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        targetCommandId: string,
    ) {
        super(commandId, createdAt, text, images, resources);
        this.targetCommandId = targetCommandId;
    }

    readonly asQueued = (): QueuedUserChatMessage =>
        new QueuedUserChatMessage(
            this.commandId,
            this.createdAt,
            this.text,
            this.images,
            this.resources,
            this.targetCommandId,
        );
}

function restoreUserMessage(turn: RecordedTurn): UserChatMessage {
    if (turn.disposition === SessionPromptDisposition.Queue) {
        return new QueuedUserChatMessage(
            turn.commandId,
            turn.createdAt,
            turn.prompt,
            turn.images,
            turn.resources,
            turn.targetCommandId,
        );
    }
    if (turn.disposition === SessionPromptDisposition.Steer) {
        return new SteeringUserChatMessage(
            turn.commandId,
            turn.createdAt,
            turn.prompt,
            turn.images,
            turn.resources,
            turn.targetCommandId,
        );
    }
    return new ImmediateUserChatMessage(turn.commandId, turn.createdAt, turn.prompt, turn.images, turn.resources);
}

export class AgentChatMessage extends ChatMessage {
    readonly activities: readonly RecordedActivity[];
    readonly commandId: string;
    readonly contents: readonly RecordedContent[];
    readonly lastCommittedSeq: string;
    readonly state: AgentTurnState;
    readonly text: string;
    readonly timing: TurnTiming;
    readonly turnId: string;

    constructor(
        id: string,
        commandId: string,
        createdAt: Date,
        text: string,
        state: AgentTurnState,
        activities: readonly RecordedActivity[] = [],
        contents: readonly RecordedContent[] = [],
        lastCommittedSeq = "0",
        turnId = "",
        timing: TurnTiming = UNTIMED_TURN,
    ) {
        super(id, createdAt);
        this.activities = activities;
        this.commandId = commandId;
        this.contents = contents;
        this.lastCommittedSeq = lastCommittedSeq;
        this.text = text;
        this.state = state;
        this.timing = timing;
        this.turnId = turnId;
    }

    static create(commandId: string): AgentChatMessage {
        const createdAt = new Date();
        return new AgentChatMessage(
            `${commandId}:agent`,
            commandId,
            createdAt,
            "",
            new AuthorizingTurnState(),
            [],
            [],
            "0",
            "",
            { kind: "running", startedAt: createdAt },
        );
    }

    static createQueued(commandId: string): AgentChatMessage {
        return new AgentChatMessage(`${commandId}:agent`, commandId, new Date(), "", new QueuedTurnState());
    }

    readonly restoreQueued = (): AgentChatMessage =>
        new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            "",
            new QueuedTurnState(),
            this.activities,
            this.contents,
            this.lastCommittedSeq,
            this.turnId,
            this.timing,
        );

    readonly appendText = (delta: string, committedSequence: string): AgentChatMessage => {
        if (BigInt(committedSequence) <= BigInt(this.lastCommittedSeq)) {
            return this;
        }
        return new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            `${this.text}${delta}`,
            this.state,
            this.activities,
            this.contents,
            committedSequence,
            this.turnId,
            this.timing,
        );
    };

    readonly recordActivity = (activity: RecordedActivity): AgentChatMessage => {
        const activities = this.activities.filter((candidate) => candidate.activityId !== activity.activityId);
        activities.push(activity);
        activities.sort((left, right) => left.sequence - right.sequence);
        return new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            this.text,
            this.state,
            activities,
            this.contents,
            this.lastCommittedSeq,
            this.turnId,
            this.timing,
        );
    };

    readonly recordContent = (event: AgentContentEvent): AgentChatMessage => {
        const contents = this.contents.filter((candidate) => candidate.contentId !== event.contentId);
        contents.push({
            commandId: event.commandId,
            content: event.content,
            contentId: event.contentId,
            messageId: event.messageId,
        });
        return new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            this.text,
            this.state,
            this.activities,
            contents,
            this.lastCommittedSeq,
            this.turnId,
            this.timing,
        );
    };

    readonly transition = (state: AgentTurnState): AgentChatMessage =>
        new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            this.text,
            state,
            this.activities,
            this.contents,
            this.lastCommittedSeq,
            this.turnId,
            advanceTurnTiming(this.timing, state),
        );

    readonly reconcileRecorded = (recorded: AgentChatMessage): AgentChatMessage => {
        const recordedSequenceKnown = recorded.lastCommittedSeq !== "0";
        const currentSequenceKnown = this.lastCommittedSeq !== "0";
        const useRecordedText = recordedSequenceKnown
            ? BigInt(recorded.lastCommittedSeq) >= BigInt(this.lastCommittedSeq)
            : !currentSequenceKnown && recorded.text.length >= this.text.length;
        return new AgentChatMessage(
            this.id,
            this.commandId,
            recorded.createdAt,
            useRecordedText ? recorded.text : this.text,
            recorded.state.progress < this.state.progress ? this.state : recorded.state,
            reconcileActivities(this.activities, recorded.activities),
            reconcileContents(this.contents, recorded.contents),
            useRecordedText ? recorded.lastCommittedSeq : this.lastCommittedSeq,
            recorded.turnId.length > 0 ? recorded.turnId : this.turnId,
            reconcileTurnTiming(this.timing, recorded.timing),
        );
    };

    readonly withFallbackText = (text: string): AgentChatMessage =>
        new AgentChatMessage(
            this.id,
            this.commandId,
            this.createdAt,
            this.text.length === 0 ? text : this.text,
            this.state,
            this.activities,
            this.contents,
            this.lastCommittedSeq,
            this.turnId,
            this.timing,
        );
}

export class Conversation {
    readonly additionalDirectories: readonly WorkspaceEntry[];
    readonly agentId: string;
    readonly agentLabel: string;
    readonly bindingId: string;
    readonly configRevision: number;
    readonly draft: string;
    readonly draftImages: readonly PromptImage[];
    readonly draftResources: readonly PromptResource[];
    readonly directoryId: string;
    readonly directoryLabel: string;
    readonly id: string;
    readonly messages: readonly ChatMessage[];
    readonly preview: string;
    readonly session: AgentSessionState;
    readonly sessionId: string;
    readonly title: string;

    get activeStateLabel(): string {
        const steeringCommands = this.steeringCommandIds();
        for (const message of this.messages.toReversed()) {
            if (
                message instanceof AgentChatMessage &&
                !steeringCommands.has(message.commandId) &&
                message.state.isStreaming
            ) {
                return message.state.label;
            }
        }
        return "";
    }

    get canStop(): boolean {
        const steeringCommands = this.steeringCommandIds();
        for (const message of this.messages.toReversed()) {
            if (
                message instanceof AgentChatMessage &&
                !steeringCommands.has(message.commandId) &&
                message.state.isStreaming
            ) {
                return message.state.canStop;
            }
        }
        return false;
    }

    get isRunning(): boolean {
        const steeringCommands = this.steeringCommandIds();
        for (const message of this.messages) {
            if (
                message instanceof AgentChatMessage &&
                !steeringCommands.has(message.commandId) &&
                message.state.isStreaming
            ) {
                return true;
            }
        }
        return false;
    }

    get followUpMessages(): readonly UserChatMessage[] {
        const agentMessages = new Map<string, AgentChatMessage>();
        for (const message of this.messages) {
            if (message instanceof AgentChatMessage) {
                agentMessages.set(message.commandId, message);
            }
        }
        const followUps: UserChatMessage[] = [];
        for (const message of this.messages) {
            if (
                message instanceof QueuedUserChatMessage &&
                agentMessages.get(message.commandId)?.state.appearance === "queued"
            ) {
                followUps.push(message);
            }
        }
        return followUps;
    }

    get transcriptMessages(): readonly ChatMessage[] {
        const pendingFollowUpIds = new Set(this.followUpMessages.map((message) => message.id));
        const steeringCommands = this.steeringCommandIds();
        const steeringByTarget = new Map<string, SteeringUserChatMessage[]>();
        for (const message of this.messages) {
            if (message instanceof SteeringUserChatMessage) {
                const messages = steeringByTarget.get(message.targetCommandId) ?? [];
                messages.push(message);
                steeringByTarget.set(message.targetCommandId, messages);
            }
        }
        const injectedSteeringIds = new Set<string>();
        const transcript: ChatMessage[] = [];
        for (const message of this.messages) {
            if (message instanceof SteeringUserChatMessage || pendingFollowUpIds.has(message.id)) {
                continue;
            }
            if (message instanceof AgentChatMessage) {
                if (steeringCommands.has(message.commandId)) {
                    continue;
                }
                if (!message.state.isStreaming) {
                    for (const steering of steeringByTarget.get(message.commandId) ?? []) {
                        transcript.push(steering);
                        injectedSteeringIds.add(steering.id);
                    }
                }
                if (message.state.appearance === "queued") {
                    continue;
                }
            }
            transcript.push(message);
        }
        for (const steeringMessages of steeringByTarget.values()) {
            for (const steering of steeringMessages) {
                if (!injectedSteeringIds.has(steering.id)) {
                    transcript.push(steering);
                }
            }
        }
        return transcript;
    }

    constructor(
        agentId: string,
        agentLabel: string,
        id: string,
        sessionId: string,
        title: string,
        preview: string,
        draft: string,
        messages: readonly ChatMessage[],
        session: AgentSessionState = new UnpreparedSessionState(),
        directoryId = "default",
        directoryLabel = "~/.mobius/workspace",
        additionalDirectories: readonly WorkspaceEntry[] = [],
        draftImages: readonly PromptImage[] = [],
        draftResources: readonly PromptResource[] = [],
        bindingId = "workspace",
        configRevision = 1,
    ) {
        this.additionalDirectories = additionalDirectories;
        this.agentId = agentId;
        this.agentLabel = agentLabel;
        this.bindingId = bindingId;
        this.configRevision = configRevision;
        this.directoryId = directoryId;
        this.directoryLabel = directoryLabel;
        this.id = id;
        this.sessionId = sessionId;
        this.session = session;
        this.title = title;
        this.preview = preview;
        this.draft = draft;
        this.draftImages = draftImages;
        this.draftResources = draftResources;
        this.messages = messages;
    }

    static create(agent: AgentOption): Conversation {
        return new Conversation(
            agent.id,
            agent.label,
            crypto.randomUUID(),
            crypto.randomUUID(),
            "New chat",
            "No messages yet",
            "",
            [],
        );
    }

    static createUsingSelections(agent: AgentOption, source: Conversation): Conversation {
        return new Conversation(
            agent.id,
            agent.label,
            crypto.randomUUID(),
            crypto.randomUUID(),
            "New chat",
            "No messages yet",
            "",
            [],
            new UnpreparedSessionState(),
            source.directoryId,
            source.directoryLabel,
            source.additionalDirectories,
        );
    }

    get contextLocked(): boolean {
        return this.messages.length > 0 || this.session.restored;
    }

    /**
     * A draft is a conversation this browser created and has not sent anything to yet. It is the only
     * conversation New chat may reopen, so it must be recognized without relying on `contextLocked`:
     * every conversation restored from the relay directory starts with no loaded turns and no restored
     * Agent context until its own route selects it, which leaves `contextLocked` false for real Sessions
     * too. Relay-backed conversations always carry their Session id as their conversation id, while the
     * New chat constructors allocate a separate id, so the two are distinguishable from the first render.
     */
    get isDraft(): boolean {
        return this.id !== this.sessionId && !this.contextLocked;
    }

    readonly matchesPreparation = (
        agentId: string,
        sessionId: string,
        directoryId: string,
        additionalDirectoryIds: readonly string[],
    ): boolean => {
        if (
            this.agentId !== agentId ||
            this.sessionId !== sessionId ||
            this.directoryId !== directoryId ||
            this.additionalDirectories.length !== additionalDirectoryIds.length
        ) {
            return false;
        }
        const expectedDirectories = new Set(additionalDirectoryIds);
        if (expectedDirectories.size !== additionalDirectoryIds.length) {
            return false;
        }
        return this.additionalDirectories.every((directory) => expectedDirectories.has(directory.directoryId));
    };

    static restore(
        agent: AgentOption,
        sessionId: string,
        turns: readonly RecordedTurn[],
        lastCommittedSeq = "0",
    ): Conversation {
        const firstTurn = turns[0];
        const lastTurn = turns.at(-1);
        if (firstTurn === undefined || lastTurn === undefined) {
            throw new Error("Cannot restore an empty conversation");
        }
        const firstConversationTurn =
            turns.find((turn) => turn.disposition !== SessionPromptDisposition.Steer) ?? firstTurn;
        const lastConversationTurn =
            turns.toReversed().find((turn) => turn.disposition !== SessionPromptDisposition.Steer) ?? lastTurn;
        const messages: ChatMessage[] = [];
        for (const turn of turns) {
            // A steering Turn is not a turn of its own: the daemon injects it into the running Turn, so it
            // contributes only its prompt. A rejected steering Turn injected nothing, so it is restored as a
            // queued follow-up instead, keeping the message recoverable rather than silently dropping it.
            if (turn.disposition === SessionPromptDisposition.Steer) {
                if (turn instanceof FailedRecordedTurn) {
                    messages.push(
                        new QueuedUserChatMessage(
                            turn.commandId,
                            turn.createdAt,
                            turn.prompt,
                            turn.images,
                            turn.resources,
                            turn.targetCommandId,
                        ),
                        new AgentChatMessage(
                            `${turn.commandId}:agent`,
                            turn.commandId,
                            turn.createdAt,
                            "",
                            new QueuedTurnState(),
                            [],
                            [],
                            lastCommittedSeq,
                            turn.turnId,
                            turn.timing,
                        ),
                    );
                    continue;
                }
                messages.push(restoreUserMessage(turn));
                continue;
            }
            messages.push(restoreUserMessage(turn));
            let state: AgentTurnState;
            let fallbackText = "";
            if (turn instanceof PendingRecordedTurn) {
                state =
                    turn.disposition === SessionPromptDisposition.Queue
                        ? new QueuedTurnState()
                        : new PendingTurnState();
            } else if (turn instanceof RunningRecordedTurn) {
                state = new RunningTurnState(turn.attemptId);
            } else if (turn instanceof CompletedRecordedTurn) {
                if (turn.stopReason === "cancelled") {
                    state = new StoppedTurnState(turn.attemptId);
                    fallbackText = "The agent stopped before returning text.";
                } else {
                    state = new CompletedTurnState(turn.attemptId, turn.stopReason);
                    fallbackText = "The agent completed without returning text.";
                }
            } else if (turn instanceof FailedRecordedTurn) {
                state = new FailedTurnState(`${turn.code}: ${turn.message}`);
                fallbackText = "The agent could not complete this request.";
            } else {
                throw new Error("Unsupported recorded turn state");
            }
            messages.push(
                new AgentChatMessage(
                    `${turn.commandId}:agent`,
                    turn.commandId,
                    turn.createdAt,
                    turn.response,
                    state,
                    turn.activities,
                    turn.contents,
                    lastCommittedSeq,
                    turn.turnId,
                    turn.timing,
                ).withFallbackText(fallbackText),
            );
        }
        return new Conversation(
            agent.id,
            agent.label,
            sessionId,
            sessionId,
            conversationTitleFromText(firstConversationTurn.prompt),
            lastConversationTurn.prompt.replaceAll(/\s+/g, " ").trim(),
            "",
            messages,
        );
    }

    static restoreWithSession(
        agent: AgentOption,
        recorded: RecordedSession,
        turns: readonly RecordedTurn[],
    ): Conversation {
        const base =
            turns.length === 0
                ? new Conversation(
                      agent.id,
                      agent.label,
                      recorded.sessionId,
                      recorded.sessionId,
                      "New chat",
                      "No messages yet",
                      "",
                      [],
                  )
                : Conversation.restore(agent, recorded.sessionId, turns, recorded.lastCommittedSeq);
        return new Conversation(
            base.agentId,
            base.agentLabel,
            base.id,
            base.sessionId,
            recorded.title.length > 0 ? recorded.title : base.title,
            recorded.nativeHistory === null ? base.preview : "Continue Agent context",
            base.draft,
            mergeNativeHistory(recorded.sessionId, recorded.nativeHistory, base.messages),
            new UnpreparedSessionState(recorded.elicitations, recorded.permissions),
            recorded.directoryId,
            directoryLabelFromId(recorded.directoryId),
            restoreAdditionalDirectories(recorded.additionalDirectoryIds),
            base.draftImages,
            base.draftResources,
            recorded.bindingId,
            recorded.configRevision,
        );
    }

    readonly reconcileRecordedTurns = (
        agent: AgentOption,
        turns: readonly RecordedTurn[],
        lastCommittedSeq = "0",
    ): Conversation => {
        const recorded = Conversation.restore(agent, this.sessionId, turns, lastCommittedSeq);
        const existingById = new Map(this.messages.map((message) => [message.id, message]));
        const recordedIds = new Set(recorded.messages.map((message) => message.id));
        const messages: ChatMessage[] = [];
        let hasUnrecordedMessages = false;
        for (const recordedMessage of recorded.messages) {
            const existingMessage = existingById.get(recordedMessage.id);
            if (recordedMessage instanceof AgentChatMessage && existingMessage instanceof AgentChatMessage) {
                messages.push(existingMessage.reconcileRecorded(recordedMessage));
            } else {
                messages.push(recordedMessage);
            }
        }
        for (const existingMessage of this.messages) {
            if (!recordedIds.has(existingMessage.id)) {
                hasUnrecordedMessages = true;
                messages.push(existingMessage);
            }
        }
        return new Conversation(
            agent.id,
            agent.label,
            this.id,
            this.sessionId,
            this.title,
            hasUnrecordedMessages ? this.preview : recorded.preview,
            this.draft,
            mergeNativeHistory(
                this.sessionId,
                this.messages.find((message) => message instanceof NativeHistoryChatMessage)?.history ?? null,
                messages,
            ),
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly reconcileRecordedSession = (
        recorded: RecordedSession,
        recordedTurns: readonly RecordedTurn[],
    ): Conversation => {
        const additionalDirectories =
            recorded.additionalDirectoryIds.length > 0 || recordedTurns.length > 0
                ? restoreAdditionalDirectories(recorded.additionalDirectoryIds, this.additionalDirectories)
                : this.additionalDirectories;
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            recorded.title.length > 0 ? recorded.title : this.title,
            recorded.nativeHistory === null ? this.preview : "Continue Agent context",
            this.draft,
            mergeNativeHistory(this.sessionId, recorded.nativeHistory, this.messages),
            this.session.withInteractions(recorded.elicitations, recorded.permissions),
            recorded.directoryId,
            this.directoryId === recorded.directoryId
                ? this.directoryLabel
                : directoryLabelFromId(recorded.directoryId),
            this.directoryId === recorded.directoryId
                ? additionalDirectories
                : restoreAdditionalDirectories(recorded.additionalDirectoryIds),
            this.draftImages,
            this.draftResources,
            recorded.bindingId,
            recorded.configRevision,
        );
    };

    readonly withNativeHistory = (history: NativeSessionHistory): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            mergeNativeHistory(this.sessionId, history, this.messages),
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly addTurn = (prompt: string, userMessage: UserChatMessage, agentMessage: AgentChatMessage): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            !this.contextLocked ? titleFromTurn(prompt, userMessage.images, userMessage.resources) : this.title,
            previewFromPrompt(prompt, userMessage.images, userMessage.resources),
            "",
            [...this.messages, userMessage, agentMessage],
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            [],
            [],
            this.bindingId,
            this.configRevision,
        );

    readonly addSteering = (userMessage: UserChatMessage): Conversation => {
        if (!this.isRunning) {
            throw new Error("Steering requires an active Agent turn");
        }
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            "",
            [...this.messages, userMessage],
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            [],
            [],
            this.bindingId,
            this.configRevision,
        );
    };

    readonly isSteeringCommand = (commandId: string): boolean =>
        this.messages.some((message) => message instanceof SteeringUserChatMessage && message.commandId === commandId);

    /**
     * A queued follow-up that the user promoted to steering is answered by the running Turn, not by its own
     * Turn. Once promoted, the steering path owns its outcome, so the original queue submission must not
     * report it as a failed Turn.
     */
    readonly isQueuedSteeringCommand = (commandId: string): boolean => this.isSteeringCommand(commandId);

    readonly promoteQueuedMessage = (commandId: string): Conversation => {
        let promoted = false;
        const messages = this.messages.map((message) => {
            if (message instanceof QueuedUserChatMessage && message.commandId === commandId) {
                promoted = true;
                return message.asSteering();
            }
            return message;
        });
        if (!promoted) {
            throw new Error("The queued follow-up is no longer available for steering");
        }
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    /**
     * Rejected steering returns the follow-up to the queue. Its Turn was promoted from a queued follow-up,
     * so its Agent message returns to the waiting state as well; otherwise the pair cannot be shown as a
     * pending follow-up and the message would be lost.
     */
    readonly restoreQueuedMessage = (commandId: string): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages.map((message) => {
                if (message instanceof SteeringUserChatMessage && message.commandId === commandId) {
                    return message.asQueued();
                }
                if (message instanceof AgentChatMessage && message.commandId === commandId) {
                    return message.restoreQueued();
                }
                return message;
            }),
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly replaceAgentMessage = (messageId: string, replacement: AgentChatMessage): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages.map((message) =>
                message instanceof AgentChatMessage && message.id === messageId ? replacement : message,
            ),
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly addDraftImage = (image: PromptImage): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            [...this.draftImages.filter((entry) => entry.name !== image.name), image],
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly addDraftResource = (resource: PromptResource): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            [...this.draftResources.filter((entry) => entry.name !== resource.name), resource],
            this.bindingId,
            this.configRevision,
        );

    readonly applyReady = (event: SessionReadyEvent): Conversation => {
        const session =
            this.session instanceof ReadySessionState
                ? new ReadySessionState(
                      event.agentName,
                      event.agentVersion,
                      event.capabilities,
                      event.commands.length > 0 ? event.commands : this.session.commands,
                      event.configOptions,
                      this.session.elicitations,
                      this.session.permissions,
                      event.restored,
                      this.session.usage,
                      this.session.updatedAt,
                  )
                : ReadySessionState.fromReady(event).withInteractions(
                      this.session.elicitations,
                      this.session.permissions,
                  );
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            session,
            event.directoryId,
            event.directoryLabel,
            event.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly markSessionFailed = (error: string): Conversation =>
        this.withSession(new SessionPreparationFailedState(error, this.session.elicitations, this.session.permissions));

    readonly markSessionInterrupted = (): Conversation =>
        this.withSession(new UnpreparedSessionState(this.session.elicitations, this.session.permissions));

    readonly markSessionPreparing = (): Conversation =>
        this.withSession(new PreparingSessionState(this.session.elicitations, this.session.permissions));

    readonly removeDraftImage = (name: string): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages.filter((image) => image.name !== name),
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly removeDraftResource = (name: string): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources.filter((resource) => resource.name !== name),
            this.bindingId,
            this.configRevision,
        );

    readonly runningTurn = (): PendingTurn => {
        const steeringCommands = this.steeringCommandIds();
        for (const message of this.messages.toReversed()) {
            if (
                message instanceof AgentChatMessage &&
                !steeringCommands.has(message.commandId) &&
                message.state.isStreaming
            ) {
                return new PendingTurn(
                    this.agentId,
                    message.commandId,
                    this.id,
                    this.sessionId,
                    message.id,
                    message.turnId,
                );
            }
        }
        throw new Error("Conversation has no active turn");
    };

    private readonly steeringCommandIds = (): ReadonlySet<string> => {
        const commandIds = new Set<string>();
        for (const message of this.messages) {
            if (message instanceof SteeringUserChatMessage) {
                commandIds.add(message.commandId);
            }
        }
        return commandIds;
    };

    readonly updateDraft = (draft: string): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly selectPrimaryDirectory = (directory: WorkspaceEntry): Conversation => {
        if (this.contextLocked || directory.directoryId === this.directoryId) {
            return this;
        }
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            new UnpreparedSessionState(),
            directory.directoryId,
            directory.name,
            this.additionalDirectories.filter((entry) => entry.directoryId !== directory.directoryId),
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly toggleAdditionalDirectory = (directory: WorkspaceEntry): Conversation => {
        const selected = this.additionalDirectories.some((entry) => entry.directoryId === directory.directoryId);
        if (
            this.contextLocked ||
            directory.directoryId === this.directoryId ||
            (!selected && !this.session.capabilities.additionalDirectories)
        ) {
            return this;
        }
        const additionalDirectories = selected
            ? this.additionalDirectories.filter((entry) => entry.directoryId !== directory.directoryId)
            : [...this.additionalDirectories, directory];
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            new UnpreparedSessionState(),
            this.directoryId,
            this.directoryLabel,
            additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly selectAgent = (agent: AgentOption): Conversation => {
        if (this.contextLocked) {
            return this;
        }
        return new Conversation(
            agent.id,
            agent.label,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            new UnpreparedSessionState(),
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly updateTitle = (title: string | null): Conversation => {
        if (title === null) {
            return this;
        }
        const firstPrompt = this.messages.find((message) => message instanceof UserChatMessage);
        const fallbackTitle =
            firstPrompt instanceof UserChatMessage
                ? titleFromTurn(firstPrompt.text, firstPrompt.images, firstPrompt.resources)
                : "New chat";
        return new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            title.length > 0 ? title : fallbackTitle,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );
    };

    readonly withSession = (session: AgentSessionState): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            this.bindingId,
            this.configRevision,
        );

    readonly withConfigBinding = (bindingId: string, configRevision: number): Conversation =>
        new Conversation(
            this.agentId,
            this.agentLabel,
            this.id,
            this.sessionId,
            this.title,
            this.preview,
            this.draft,
            this.messages,
            this.session,
            this.directoryId,
            this.directoryLabel,
            this.additionalDirectories,
            this.draftImages,
            this.draftResources,
            bindingId,
            configRevision,
        );
}

export class PendingTurn {
    readonly agentId: string;
    readonly agentMessageId: string;
    readonly commandId: string;
    readonly conversationId: string;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(
        agentId: string,
        commandId: string,
        conversationId: string,
        sessionId: string,
        agentMessageId: string,
        turnId = "",
    ) {
        this.agentId = agentId;
        this.commandId = commandId;
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.agentMessageId = agentMessageId;
        this.turnId = turnId;
    }
}

export class SteeringTurn {
    readonly agentId: string;
    readonly commandId: string;
    readonly conversationId: string;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(agentId: string, commandId: string, conversationId: string, sessionId: string, turnId = "") {
        this.agentId = agentId;
        this.commandId = commandId;
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.turnId = turnId;
    }
}

function activityProgress(status: string): number {
    if (status === "pending") {
        return 0;
    }
    if (status === "running") {
        return 1;
    }
    return 2;
}

/**
 * Moves Turn timing forward for a state change. A Turn starts its clock when it begins streaming and
 * measures elapsed time once it settles, using only browser readings so the measurement is coherent.
 */
function advanceTurnTiming(timing: TurnTiming, state: AgentTurnState): TurnTiming {
    if (state.settled) {
        return timing.kind === "running"
            ? {
                  elapsedMilliseconds: Math.max(0, Date.now() - timing.startedAt.getTime()),
                  kind: "measured",
              }
            : timing;
    }
    if (state.isStreaming && timing.kind === "untimed") {
        return { kind: "running", startedAt: new Date() };
    }
    return timing;
}

/**
 * Keeps a locally started measurement over a recorded one so elapsed time stays on a single clock,
 * and adopts relay timing only when this browser never observed the Turn running.
 */
function reconcileTurnTiming(current: TurnTiming, recorded: TurnTiming): TurnTiming {
    return current.kind === "untimed" ? recorded : current;
}

function activityDetailLength(activity: RecordedActivity): number {
    return activity.input.length + activity.output.length + activity.locations.join("").length;
}

function reconcileActivities(
    existing: readonly RecordedActivity[],
    recorded: readonly RecordedActivity[],
): readonly RecordedActivity[] {
    const activities = new Map<string, RecordedActivity>();
    for (const activity of existing) {
        activities.set(activity.activityId, activity);
    }
    for (const activity of recorded) {
        const current = activities.get(activity.activityId);
        if (
            current === undefined ||
            activityProgress(activity.status) > activityProgress(current.status) ||
            (activityProgress(activity.status) === activityProgress(current.status) &&
                activityDetailLength(activity) >= activityDetailLength(current))
        ) {
            activities.set(activity.activityId, activity);
        }
    }
    return [...activities.values()].sort((left, right) => left.sequence - right.sequence);
}

function reconcileContents(
    existing: readonly RecordedContent[],
    recorded: readonly RecordedContent[],
): readonly RecordedContent[] {
    const contents = new Map<string, RecordedContent>();
    for (const content of existing) {
        contents.set(content.contentId, content);
    }
    for (const content of recorded) {
        contents.set(content.contentId, content);
    }
    return [...contents.values()];
}

function formatCompactNumber(value: number): string {
    return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 1,
        notation: "compact",
    }).format(value);
}

function previewFromPrompt(
    prompt: string,
    images: readonly PromptImage[],
    resources: readonly PromptResource[],
): string {
    const compact = prompt.replaceAll(/\s+/g, " ").trim();
    if (compact.length > 0) {
        return compact;
    }
    const attachmentCount = images.length + resources.length;
    return `${attachmentCount.toString()} ${attachmentCount === 1 ? "attachment" : "attachments"}`;
}

function titleFromTurn(prompt: string, images: readonly PromptImage[], resources: readonly PromptResource[]): string {
    const compact = prompt.trim();
    if (compact.length > 0) {
        return conversationTitleFromText(prompt);
    }
    const firstAttachment = images[0]?.name ?? resources[0]?.name ?? "Attachment";
    return conversationTitleFromText(firstAttachment);
}
