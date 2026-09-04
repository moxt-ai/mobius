import type {
  AgentActivityEvent,
  AgentMessageDeltaEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  SessionPromptCommand,
  SessionStartedEvent,
} from "@moxt-ai/mobius-protocol";

export class RecordedActivity {
  readonly activityId: string;
  readonly activityType: string;
  readonly input: string;
  readonly locations: readonly string[];
  readonly name: string;
  readonly output: string;
  readonly sequence: number;
  readonly status: string;
  readonly title: string;
  readonly toolKind: string;

  constructor(
    activityId: string,
    activityType: string,
    input: string,
    locations: readonly string[],
    name: string,
    output: string,
    sequence: number,
    status: string,
    title: string,
    toolKind: string,
  ) {
    this.activityId = activityId;
    this.activityType = activityType;
    this.input = input;
    this.locations = locations;
    this.name = name;
    this.output = output;
    this.sequence = sequence;
    this.status = status;
    this.title = title;
    this.toolKind = toolKind;
  }

  static fromEvent(event: AgentActivityEvent): RecordedActivity {
    return new RecordedActivity(
      event.activityId,
      event.activityType,
      event.input,
      event.locations,
      event.name,
      event.output,
      event.sequence,
      event.status,
      event.title,
      event.toolKind,
    );
  }
}

export abstract class RecordedTurn {
  readonly activities: readonly RecordedActivity[];
  readonly agentId: string;
  readonly commandId: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly response: string;
  readonly sessionId: string;
  abstract readonly status: string;

  protected constructor(
    agentId: string,
    commandId: string,
    createdAt: string,
    prompt: string,
    response: string,
    sessionId: string,
    activities: readonly RecordedActivity[],
  ) {
    this.activities = activities;
    this.agentId = agentId;
    this.commandId = commandId;
    this.createdAt = createdAt;
    this.prompt = prompt;
    this.response = response;
    this.sessionId = sessionId;
  }
}

export class PendingRecordedTurn extends RecordedTurn {
  readonly status = "pending";

  constructor(
    agentId: string,
    commandId: string,
    createdAt: string,
    prompt: string,
    response: string,
    sessionId: string,
    activities: readonly RecordedActivity[] = [],
  ) {
    super(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      activities,
    );
  }
}

export class RunningRecordedTurn extends RecordedTurn {
  readonly processAttemptId: string;
  readonly status = "running";

  constructor(
    agentId: string,
    commandId: string,
    createdAt: string,
    prompt: string,
    response: string,
    sessionId: string,
    processAttemptId: string,
    activities: readonly RecordedActivity[] = [],
  ) {
    super(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      activities,
    );
    this.processAttemptId = processAttemptId;
  }
}

export class CompletedRecordedTurn extends RecordedTurn {
  readonly processAttemptId: string;
  readonly status = "completed";
  readonly stopReason: string;

  constructor(
    agentId: string,
    commandId: string,
    createdAt: string,
    prompt: string,
    response: string,
    sessionId: string,
    processAttemptId: string,
    stopReason: string,
    activities: readonly RecordedActivity[] = [],
  ) {
    super(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      activities,
    );
    this.processAttemptId = processAttemptId;
    this.stopReason = stopReason;
  }
}

export class FailedRecordedTurn extends RecordedTurn {
  readonly code: string;
  readonly message: string;
  readonly status = "failed";

  constructor(
    agentId: string,
    commandId: string,
    createdAt: string,
    prompt: string,
    response: string,
    sessionId: string,
    code: string,
    message: string,
    activities: readonly RecordedActivity[] = [],
  ) {
    super(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      activities,
    );
    this.code = code;
    this.message = message;
  }
}

export class ChannelHistory {
  readonly runtimeId: string;
  readonly turns: readonly RecordedTurn[];

  constructor(runtimeId: string, turns: readonly RecordedTurn[]) {
    this.runtimeId = runtimeId;
    this.turns = turns;
  }
}

export interface ChannelTurnStore {
  readonly appendDelta: (event: AgentMessageDeltaEvent, now: number) => void;
  readonly complete: (event: SessionCompletedEvent, now: number) => void;
  readonly fail: (event: SessionFailedEvent, now: number) => void;
  readonly markStarted: (event: SessionStartedEvent, now: number) => void;
  readonly readTurns: () => readonly RecordedTurn[];
  readonly recordActivity: (event: AgentActivityEvent, now: number) => void;
  readonly recordPrompt: (command: SessionPromptCommand, now: number) => void;
}
