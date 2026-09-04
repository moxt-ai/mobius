import {
  type AgentOption,
  CompletedRecordedTurn,
  FailedRecordedTurn,
  PendingRecordedTurn,
  type RecordedActivity,
  type RecordedTurn,
  RunningRecordedTurn,
} from "@/domain/channel";

export interface RunDetail {
  readonly label: string;
  readonly value: string;
}

export abstract class RuntimeConnectionState {
  abstract readonly canSend: boolean;
  abstract readonly description: string;
  abstract readonly label: string;
  abstract readonly sidebarLabel: string;
}

export class ConnectingRuntimeState extends RuntimeConnectionState {
  readonly canSend = false;
  readonly description = "Connecting to the local runtime…";
  readonly label = "Connecting";
  readonly sidebarLabel = "Connecting to runtime";
}

export class OnlineRuntimeState extends RuntimeConnectionState {
  readonly canSend = true;
  readonly description = "Connected through the local Mobius relay";
  readonly label = "Runtime online";
  readonly sidebarLabel = "Runtime online";
}

export class OfflineRuntimeState extends RuntimeConnectionState {
  readonly canSend = false;
  readonly description =
    "The local runtime is offline. Messages cannot be sent yet.";
  readonly label = "Runtime offline";
  readonly sidebarLabel = "Waiting for runtime";
}

export class UnavailableRuntimeState extends RuntimeConnectionState {
  readonly canSend = false;
  readonly description =
    "The relay is unavailable. Start the local stack, then reload this page.";
  readonly label = "Relay unavailable";
  readonly sidebarLabel = "Relay unavailable";
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
  readonly text: string;

  constructor(id: string, createdAt: Date, text: string) {
    super(id, createdAt);
    this.text = text;
  }

  static create(commandId: string, text: string): UserChatMessage {
    return new UserChatMessage(`${commandId}:user`, new Date(), text);
  }
}

export class AgentChatMessage extends ChatMessage {
  readonly activities: readonly RecordedActivity[];
  readonly commandId: string;
  readonly state: AgentTurnState;
  readonly text: string;

  constructor(
    id: string,
    commandId: string,
    createdAt: Date,
    text: string,
    state: AgentTurnState,
    activities: readonly RecordedActivity[] = [],
  ) {
    super(id, createdAt);
    this.activities = activities;
    this.commandId = commandId;
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
    );

  readonly withFallbackText = (text: string): AgentChatMessage =>
    new AgentChatMessage(
      this.id,
      this.commandId,
      this.createdAt,
      this.text.length === 0 ? text : this.text,
      this.state,
      this.activities,
    );
}

export class Conversation {
  readonly agentId: string;
  readonly agentLabel: string;
  readonly draft: string;
  readonly id: string;
  readonly messages: readonly ChatMessage[];
  readonly preview: string;
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
  ) {
    this.agentId = agentId;
    this.agentLabel = agentLabel;
    this.id = id;
    this.sessionId = sessionId;
    this.title = title;
    this.preview = preview;
    this.draft = draft;
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
    );
  };

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
      this.messages.length === 0 ? titleFromPrompt(prompt) : this.title,
      prompt.replaceAll(/\s+/g, " ").trim(),
      "",
      [...this.messages, userMessage, agentMessage],
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
    );

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
    );
  };
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

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= 42) {
    return compact;
  }
  return `${characters.slice(0, 41).join("")}…`;
}
