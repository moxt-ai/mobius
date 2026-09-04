import type {
  AgentContentEvent,
  PromptImage,
  PromptResource,
  SessionCapabilities,
  SessionCommand,
  SessionConfigOption,
  SessionElicitationRequestedEvent,
  SessionElicitationResolvedEvent,
  SessionPermissionRequestedEvent,
  SessionReadyEvent,
  SessionUsageUpdatedEvent,
  WorkspaceEntry,
} from "@moxt-ai/mobius-web-sdk";
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
  resumeSession: false,
};

export abstract class SessionUsageState {
  abstract readonly available: boolean;
  abstract readonly costLabel: string;
  abstract readonly percent: number;
  abstract readonly size: number;
  abstract readonly summary: string;
  abstract readonly used: number;
}

class UnknownSessionUsage extends SessionUsageState {
  readonly available = false;
  readonly costLabel = "";
  readonly percent = 0;
  readonly size = 0;
  readonly summary = "Context usage unavailable";
  readonly used = 0;
}

class MeasuredSessionUsage extends SessionUsageState {
  readonly available = true;
  readonly costLabel: string;
  readonly percent: number;
  readonly size: number;
  readonly summary: string;
  readonly used: number;

  constructor(event: SessionUsageUpdatedEvent) {
    super();
    this.size = event.size;
    this.used = event.used;
    this.percent =
      event.size === 0
        ? 0
        : Math.min(100, Math.round((event.used / event.size) * 100));
    this.summary = `${formatCompactNumber(event.used)} / ${formatCompactNumber(event.size)} tokens`;
    if (!event.hasCost) {
      this.costLabel = "";
    } else if (event.costCurrency.toUpperCase() === "USD") {
      this.costLabel = `$${event.costAmount.toFixed(2)} ${event.costCurrency}`;
    } else {
      this.costLabel = `${event.costAmount.toFixed(2)} ${event.costCurrency}`;
    }
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

export class UnpreparedSessionState extends AgentSessionState {
  readonly autoPrepare = true;
  readonly isPreparing = false;
  readonly isReady = false;
  readonly label = "Agent settings not loaded";
  readonly updatedAt = "";

  constructor() {
    super(
      "",
      "",
      EMPTY_CAPABILITIES,
      [],
      [],
      [],
      [],
      false,
      new UnknownSessionUsage(),
    );
  }
}

class PreparingSessionState extends AgentSessionState {
  readonly autoPrepare = false;
  readonly isPreparing = true;
  readonly isReady = false;
  readonly label = "Loading agent settings";
  readonly updatedAt = "";

  constructor() {
    super(
      "",
      "",
      EMPTY_CAPABILITIES,
      [],
      [],
      [],
      [],
      false,
      new UnknownSessionUsage(),
    );
  }
}

export class SessionPreparationFailedState extends AgentSessionState {
  readonly autoPrepare = false;
  readonly error: string;
  readonly isPreparing = false;
  readonly isReady = false;
  readonly label = "Agent settings unavailable";
  readonly updatedAt = "";

  constructor(error: string) {
    super(
      "",
      "",
      EMPTY_CAPABILITIES,
      [],
      [],
      [],
      [],
      false,
      new UnknownSessionUsage(),
    );
    this.error = error;
  }
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

  static fromRecorded(recorded: RecordedSession): ReadySessionState {
    const latestUsage = recorded.usage.at(-1);
    return new ReadySessionState(
      recorded.agentName,
      recorded.agentVersion,
      recorded.capabilities,
      recorded.commands,
      recorded.configOptions,
      recorded.pendingElicitations,
      recorded.pendingPermissions,
      recorded.restored,
      latestUsage === undefined
        ? new UnknownSessionUsage()
        : new MeasuredSessionUsage(latestUsage),
      recorded.updatedAt,
    );
  }

  readonly withCommands = (
    commands: readonly SessionCommand[],
  ): ReadySessionState =>
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

  readonly withConfig = (
    configOptions: readonly SessionConfigOption[],
  ): ReadySessionState =>
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

  readonly withElicitation = (
    elicitation: SessionElicitationRequestedEvent,
  ): ReadySessionState =>
    new ReadySessionState(
      this.agentName,
      this.agentVersion,
      this.capabilities,
      this.commands,
      this.configOptions,
      [
        ...this.elicitations.filter(
          (candidate) => candidate.interactionId !== elicitation.interactionId,
        ),
        elicitation,
      ],
      this.permissions,
      this.restored,
      this.usage,
      this.updatedAt,
    );

  readonly withPermission = (
    permission: SessionPermissionRequestedEvent,
  ): ReadySessionState =>
    new ReadySessionState(
      this.agentName,
      this.agentVersion,
      this.capabilities,
      this.commands,
      this.configOptions,
      this.elicitations,
      [
        ...this.permissions.filter(
          (candidate) => candidate.interactionId !== permission.interactionId,
        ),
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
      new MeasuredSessionUsage(usage),
      this.updatedAt,
    );

  readonly withoutElicitation = (interactionId: string): ReadySessionState =>
    new ReadySessionState(
      this.agentName,
      this.agentVersion,
      this.capabilities,
      this.commands,
      this.configOptions,
      this.elicitations.filter(
        (candidate) => candidate.interactionId !== interactionId,
      ),
      this.permissions,
      this.restored,
      this.usage,
      this.updatedAt,
    );

  readonly resolveElicitation = (
    event: SessionElicitationResolvedEvent,
  ): ReadySessionState => {
    const elicitation = this.elicitations.find(
      (entry) => entry.interactionId === event.interactionId,
    );
    if (
      event.action !== "accept" ||
      elicitation === undefined ||
      elicitation.mode !== "url"
    ) {
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
      this.permissions.filter(
        (candidate) => candidate.interactionId !== interactionId,
      ),
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

export type RuntimeConnectionAppearance =
  | "connecting"
  | "offline"
  | "online"
  | "unavailable";

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

export class OnlineRuntimeState extends RuntimeConnectionState {
  readonly appearance = "online";
  readonly canSend = true;
  readonly description = "Connected through the local Mobius relay";
  readonly label = "Runtime online";
}

export class OfflineRuntimeState extends RuntimeConnectionState {
  readonly appearance = "offline";
  readonly canSend = false;
  readonly description =
    "The local runtime is offline. Messages cannot be sent yet.";
  readonly label = "Runtime offline";
}

export class UnavailableRuntimeState extends RuntimeConnectionState {
  readonly appearance = "unavailable";
  readonly canSend = false;
  readonly description =
    "The relay is unavailable. Start the local stack, then reload this page.";
  readonly label = "Relay unavailable";
}

export abstract class AgentTurnState {
  abstract readonly appearance: string;
  abstract readonly canStop: boolean;
  abstract readonly isStreaming: boolean;
  abstract readonly label: string;
  abstract readonly progress: number;
  abstract readonly details: (sessionId: string) => readonly RunDetail[];
  abstract readonly stop: () => AgentTurnState;
}

class AuthorizingTurnState extends AgentTurnState {
  readonly appearance = "working";
  readonly canStop = true;
  readonly isStreaming = true;
  readonly label = "Authorizing";
  readonly progress = 0;
  readonly details = (sessionId: string): readonly RunDetail[] => [
    { label: "Session", value: sessionId },
    { label: "State", value: "Checking local workspace access" },
  ];
  readonly stop = (): AgentTurnState => new StoppingTurnState("Pending");
}

export class PendingTurnState extends AgentTurnState {
  readonly appearance = "working";
  readonly canStop = true;
  readonly isStreaming = true;
  readonly label = "Pending";
  readonly progress = 0;
  readonly details = (sessionId: string): readonly RunDetail[] => [
    { label: "Session", value: sessionId },
    { label: "State", value: "Waiting for the local runtime" },
  ];
  readonly stop = (): AgentTurnState => new StoppingTurnState("Pending");
}

export class RunningTurnState extends AgentTurnState {
  readonly appearance = "working";
  readonly canStop = true;
  readonly isStreaming = true;
  readonly label = "Working";
  readonly progress = 1;
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

  readonly withAttemptId = (attemptId: string): StoppingTurnState =>
    new StoppingTurnState(attemptId);
}

export class CompletedTurnState extends AgentTurnState {
  readonly appearance = "completed";
  readonly canStop = false;
  readonly isStreaming = false;
  readonly label = "Completed";
  readonly progress = 2;
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

export class UserChatMessage extends ChatMessage {
  readonly images: readonly PromptImage[];
  readonly resources: readonly PromptResource[];
  readonly text: string;

  constructor(
    id: string,
    createdAt: Date,
    text: string,
    images: readonly PromptImage[] = [],
    resources: readonly PromptResource[] = [],
  ) {
    super(id, createdAt);
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
    return new UserChatMessage(
      `${commandId}:user`,
      new Date(),
      text,
      images,
      resources,
    );
  }
}

export class AgentChatMessage extends ChatMessage {
  readonly activities: readonly RecordedActivity[];
  readonly commandId: string;
  readonly contents: readonly RecordedContent[];
  readonly state: AgentTurnState;
  readonly text: string;

  constructor(
    id: string,
    commandId: string,
    createdAt: Date,
    text: string,
    state: AgentTurnState,
    activities: readonly RecordedActivity[] = [],
    contents: readonly RecordedContent[] = [],
  ) {
    super(id, createdAt);
    this.activities = activities;
    this.commandId = commandId;
    this.contents = contents;
    this.text = text;
    this.state = state;
  }

  static create(commandId: string): AgentChatMessage {
    return new AgentChatMessage(
      `${commandId}:agent`,
      commandId,
      new Date(),
      "",
      new AuthorizingTurnState(),
    );
  }

  readonly appendText = (delta: string): AgentChatMessage =>
    new AgentChatMessage(
      this.id,
      this.commandId,
      this.createdAt,
      `${this.text}${delta}`,
      this.state,
      this.activities,
      this.contents,
    );

  readonly recordActivity = (activity: RecordedActivity): AgentChatMessage => {
    const activities = this.activities.filter(
      (candidate) => candidate.activityId !== activity.activityId,
    );
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
    );
  };

  readonly recordContent = (event: AgentContentEvent): AgentChatMessage => {
    const contents = this.contents.filter(
      (candidate) => candidate.contentId !== event.contentId,
    );
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
    );

  readonly reconcileRecorded = (recorded: AgentChatMessage): AgentChatMessage =>
    new AgentChatMessage(
      this.id,
      this.commandId,
      recorded.createdAt,
      recorded.text.length < this.text.length ? this.text : recorded.text,
      recorded.state.progress < this.state.progress
        ? this.state
        : recorded.state,
      reconcileActivities(this.activities, recorded.activities),
      reconcileContents(this.contents, recorded.contents),
    );

  readonly withFallbackText = (text: string): AgentChatMessage =>
    new AgentChatMessage(
      this.id,
      this.commandId,
      this.createdAt,
      this.text.length === 0 ? text : this.text,
      this.state,
      this.activities,
      this.contents,
    );
}

export class Conversation {
  readonly additionalDirectories: readonly WorkspaceEntry[];
  readonly agentId: string;
  readonly agentLabel: string;
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
    for (const message of this.messages.toReversed()) {
      if (message instanceof AgentChatMessage && message.state.isStreaming) {
        return message.state.label;
      }
    }
    return "";
  }

  get canStop(): boolean {
    for (const message of this.messages.toReversed()) {
      if (message instanceof AgentChatMessage && message.state.isStreaming) {
        return message.state.canStop;
      }
    }
    return false;
  }

  get isRunning(): boolean {
    for (const message of this.messages) {
      if (message instanceof AgentChatMessage && message.state.isStreaming) {
        return true;
      }
    }
    return false;
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
    directoryId = "root",
    directoryLabel = "Workspace",
    additionalDirectories: readonly WorkspaceEntry[] = [],
    draftImages: readonly PromptImage[] = [],
    draftResources: readonly PromptResource[] = [],
  ) {
    this.additionalDirectories = additionalDirectories;
    this.agentId = agentId;
    this.agentLabel = agentLabel;
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
    return this.additionalDirectories.every((directory) =>
      expectedDirectories.has(directory.directoryId),
    );
  };

  static restore(
    agent: AgentOption,
    sessionId: string,
    turns: readonly RecordedTurn[],
  ): Conversation {
    const firstTurn = turns[0];
    const lastTurn = turns.at(-1);
    if (firstTurn === undefined || lastTurn === undefined) {
      throw new Error("Cannot restore an empty conversation");
    }
    const messages: ChatMessage[] = [];
    for (const turn of turns) {
      messages.push(
        new UserChatMessage(
          `${turn.commandId}:user`,
          turn.createdAt,
          turn.prompt,
          turn.images,
          turn.resources,
        ),
      );
      let state: AgentTurnState;
      let fallbackText = "";
      if (turn instanceof PendingRecordedTurn) {
        state = new PendingTurnState();
      } else if (turn instanceof RunningRecordedTurn) {
        state = new RunningTurnState(turn.processAttemptId);
      } else if (turn instanceof CompletedRecordedTurn) {
        if (turn.stopReason === "cancelled") {
          state = new StoppedTurnState(turn.processAttemptId);
          fallbackText = "The agent stopped before returning text.";
        } else {
          state = new CompletedTurnState(
            turn.processAttemptId,
            turn.stopReason,
          );
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
        ).withFallbackText(fallbackText),
      );
    }
    return new Conversation(
      agent.id,
      agent.label,
      sessionId,
      sessionId,
      titleFromPrompt(firstTurn.prompt),
      lastTurn.prompt.replaceAll(/\s+/g, " ").trim(),
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
        : Conversation.restore(agent, recorded.sessionId, turns);
    return new Conversation(
      base.agentId,
      base.agentLabel,
      base.id,
      base.sessionId,
      recorded.title.length > 0 ? recorded.title : base.title,
      base.preview,
      base.draft,
      base.messages,
      ReadySessionState.fromRecorded(recorded),
      recorded.directoryId,
      recorded.directoryLabel,
      recorded.additionalDirectories,
      base.draftImages,
      base.draftResources,
    );
  }

  readonly reconcileRecordedTurns = (
    agent: AgentOption,
    turns: readonly RecordedTurn[],
  ): Conversation => {
    const recorded = Conversation.restore(agent, this.sessionId, turns);
    const existingById = new Map(
      this.messages.map((message) => [message.id, message]),
    );
    const recordedIds = new Set(recorded.messages.map((message) => message.id));
    const messages: ChatMessage[] = [];
    let hasUnrecordedMessages = false;
    for (const recordedMessage of recorded.messages) {
      const existingMessage = existingById.get(recordedMessage.id);
      if (
        recordedMessage instanceof AgentChatMessage &&
        existingMessage instanceof AgentChatMessage
      ) {
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
      messages,
      this.session,
      this.directoryId,
      this.directoryLabel,
      this.additionalDirectories,
      this.draftImages,
      this.draftResources,
    );
  };

  readonly reconcileRecordedSession = (
    recorded: RecordedSession,
  ): Conversation =>
    new Conversation(
      this.agentId,
      this.agentLabel,
      this.id,
      this.sessionId,
      recorded.title.length > 0 ? recorded.title : this.title,
      this.preview,
      this.draft,
      this.messages,
      ReadySessionState.fromRecorded(recorded),
      recorded.directoryId,
      recorded.directoryLabel,
      recorded.additionalDirectories,
      this.draftImages,
      this.draftResources,
    );

  readonly addTurn = (
    prompt: string,
    userMessage: UserChatMessage,
    agentMessage: AgentChatMessage,
  ): Conversation =>
    new Conversation(
      this.agentId,
      this.agentLabel,
      this.id,
      this.sessionId,
      this.messages.length === 0
        ? titleFromTurn(prompt, userMessage.images, userMessage.resources)
        : this.title,
      previewFromPrompt(prompt, userMessage.images, userMessage.resources),
      "",
      [...this.messages, userMessage, agentMessage],
      this.session,
      this.directoryId,
      this.directoryLabel,
      this.additionalDirectories,
      [],
      [],
    );

  readonly replaceAgentMessage = (
    messageId: string,
    replacement: AgentChatMessage,
  ): Conversation =>
    new Conversation(
      this.agentId,
      this.agentLabel,
      this.id,
      this.sessionId,
      this.title,
      this.preview,
      this.draft,
      this.messages.map((message) =>
        message instanceof AgentChatMessage && message.id === messageId
          ? replacement
          : message,
      ),
      this.session,
      this.directoryId,
      this.directoryLabel,
      this.additionalDirectories,
      this.draftImages,
      this.draftResources,
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
      [
        ...this.draftResources.filter((entry) => entry.name !== resource.name),
        resource,
      ],
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
        : ReadySessionState.fromReady(event);
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
    );
  };

  readonly markSessionFailed = (error: string): Conversation =>
    this.withSession(new SessionPreparationFailedState(error));

  readonly markSessionPreparing = (): Conversation =>
    this.withSession(new PreparingSessionState());

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
    );

  readonly runningTurn = (): PendingTurn => {
    for (const message of this.messages.toReversed()) {
      if (message instanceof AgentChatMessage && message.state.isStreaming) {
        return new PendingTurn(
          this.agentId,
          message.commandId,
          this.id,
          this.sessionId,
          message.id,
        );
      }
    }
    throw new Error("Conversation has no active turn");
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
    );

  readonly selectPrimaryDirectory = (
    directory: WorkspaceEntry,
  ): Conversation => {
    if (
      this.messages.length > 0 ||
      directory.directoryId === this.directoryId
    ) {
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
      this.additionalDirectories.filter(
        (entry) => entry.directoryId !== directory.directoryId,
      ),
      this.draftImages,
      this.draftResources,
    );
  };

  readonly toggleAdditionalDirectory = (
    directory: WorkspaceEntry,
  ): Conversation => {
    const selected = this.additionalDirectories.some(
      (entry) => entry.directoryId === directory.directoryId,
    );
    if (
      this.messages.length > 0 ||
      directory.directoryId === this.directoryId ||
      (!selected && !this.session.capabilities.additionalDirectories)
    ) {
      return this;
    }
    const additionalDirectories = selected
      ? this.additionalDirectories.filter(
          (entry) => entry.directoryId !== directory.directoryId,
        )
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
    );
  };

  readonly selectAgent = (agent: AgentOption): Conversation => {
    if (this.messages.length > 0) {
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
    );
  };

  readonly updateTitle = (title: string): Conversation => {
    const firstPrompt = this.messages.find(
      (message) => message instanceof UserChatMessage,
    );
    const fallbackTitle =
      firstPrompt instanceof UserChatMessage
        ? titleFromTurn(
            firstPrompt.text,
            firstPrompt.images,
            firstPrompt.resources,
          )
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
    );
}

export class PendingTurn {
  readonly agentId: string;
  readonly agentMessageId: string;
  readonly commandId: string;
  readonly conversationId: string;
  readonly sessionId: string;

  constructor(
    agentId: string,
    commandId: string,
    conversationId: string,
    sessionId: string,
    agentMessageId: string,
  ) {
    this.agentId = agentId;
    this.commandId = commandId;
    this.conversationId = conversationId;
    this.sessionId = sessionId;
    this.agentMessageId = agentMessageId;
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

function activityDetailLength(activity: RecordedActivity): number {
  return (
    activity.input.length +
    activity.output.length +
    activity.locations.join("").length
  );
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
  return [...activities.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
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

function titleFromTurn(
  prompt: string,
  images: readonly PromptImage[],
  resources: readonly PromptResource[],
): string {
  const compact = prompt.trim();
  if (compact.length > 0) {
    return titleFromPrompt(prompt);
  }
  const firstAttachment = images[0]?.name ?? resources[0]?.name ?? "Attachment";
  return titleFromPrompt(firstAttachment);
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= 42) {
    return compact;
  }
  return `${characters.slice(0, 41).join("")}…`;
}
