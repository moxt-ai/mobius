export const SESSION_PROMPT_KIND = "session.prompt";
export const SESSION_CANCEL_KIND = "session.cancel";
export const RUNTIME_STATUS_KIND = "runtime.status";
export const SESSION_STARTED_KIND = "session.started";
export const AGENT_MESSAGE_DELTA_KIND = "agent.message.delta";
export const AGENT_ACTIVITY_KIND = "agent.activity";
export const AGENT_ACTIVITY_DETAIL_LIMIT = 24_000;
export const AGENT_ACTIVITY_LOCATION_LIMIT = 12;
export const AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT = 1_024;
export const SESSION_COMPLETED_KIND = "session.completed";
export const SESSION_FAILED_KIND = "session.failed";

export interface SessionPromptCommand {
  readonly agentId: string;
  readonly bindingId: string;
  readonly commandId: string;
  readonly kind: typeof SESSION_PROMPT_KIND;
  readonly prompt: string;
  readonly protocolVersion: number;
  readonly sessionId: string;
}

export interface SessionCancelCommand {
  readonly commandId: string;
  readonly kind: typeof SESSION_CANCEL_KIND;
  readonly protocolVersion: number;
  readonly sessionId: string;
}

export interface RuntimeStatusEvent {
  readonly kind: typeof RUNTIME_STATUS_KIND;
  readonly online: boolean;
  readonly protocolVersion: number;
  readonly runtimeId: string;
}

export interface SessionStartedEvent {
  readonly commandId: string;
  readonly kind: typeof SESSION_STARTED_KIND;
  readonly processAttemptId: string;
  readonly protocolVersion: number;
  readonly sessionId: string;
}

export interface AgentMessageDeltaEvent {
  readonly commandId: string;
  readonly kind: typeof AGENT_MESSAGE_DELTA_KIND;
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly text: string;
}

export interface AgentActivityEvent {
  readonly activityId: string;
  readonly activityType: string;
  readonly commandId: string;
  readonly input: string;
  readonly kind: typeof AGENT_ACTIVITY_KIND;
  readonly locations: readonly string[];
  readonly name: string;
  readonly output: string;
  readonly protocolVersion: number;
  readonly sequence: number;
  readonly sessionId: string;
  readonly status: string;
  readonly title: string;
  readonly toolKind: string;
}

export interface SessionCompletedEvent {
  readonly commandId: string;
  readonly kind: typeof SESSION_COMPLETED_KIND;
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly stopReason: string;
}

export interface SessionFailedEvent {
  readonly code: string;
  readonly commandId: string;
  readonly kind: typeof SESSION_FAILED_KIND;
  readonly message: string;
  readonly protocolVersion: number;
  readonly sessionId: string;
}
