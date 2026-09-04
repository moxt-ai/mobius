const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;

export class AgentOption {
  readonly id: string;
  readonly label: string;

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }
}

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
}

export class ChannelConnection {
  readonly agents: readonly AgentOption[];
  readonly channelId: string;
  readonly machineName: string;
  readonly workspaceName: string;

  constructor(
    agents: readonly AgentOption[],
    channelId: string,
    machineName: string,
    workspaceName: string,
  ) {
    this.agents = agents;
    this.channelId = channelId;
    this.machineName = machineName;
    this.workspaceName = workspaceName;
  }
}

export abstract class RecordedTurn {
  readonly activities: readonly RecordedActivity[];
  readonly agentId: string;
  readonly commandId: string;
  readonly createdAt: Date;
  readonly prompt: string;
  readonly response: string;
  readonly sessionId: string;
  abstract readonly status: string;

  protected constructor(
    agentId: string,
    commandId: string,
    createdAt: Date,
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
    createdAt: Date,
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
    createdAt: Date,
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
    createdAt: Date,
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
    createdAt: Date,
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
  readonly turns: readonly RecordedTurn[];

  constructor(turns: readonly RecordedTurn[]) {
    this.turns = turns;
  }
}

export class CreatedPairing {
  readonly channelId: string;
  readonly expiresAt: Date;
  readonly pairingCode: string;
  readonly pairingId: string;
  readonly pollToken: string;

  constructor(
    pairingId: string,
    pairingCode: string,
    pollToken: string,
    channelId: string,
    expiresAt: Date,
  ) {
    this.pairingId = pairingId;
    this.pairingCode = pairingCode;
    this.pollToken = pollToken;
    this.channelId = channelId;
    this.expiresAt = expiresAt;
  }
}

export abstract class BrowserPairingStatus {
  abstract readonly status: string;
}

export class WaitingBrowserPairingStatus extends BrowserPairingStatus {
  readonly expiresAt: Date;
  readonly status = "pending";

  constructor(expiresAt: Date) {
    super();
    this.expiresAt = expiresAt;
  }
}

export class ExpiredBrowserPairingStatus extends BrowserPairingStatus {
  readonly status = "expired";
}

export class ConnectedBrowserPairingStatus extends BrowserPairingStatus {
  readonly connection: ChannelConnection;
  readonly status = "paired";

  constructor(connection: ChannelConnection) {
    super();
    this.connection = connection;
  }
}

export class PairingApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "PairingApiError";
  }
}

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

export function isToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function isPairingCode(value: string): boolean {
  return PAIRING_CODE_PATTERN.test(value);
}
