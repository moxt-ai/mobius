import type { SessionConfigurationSelection } from "./control-messages.ts";

export const SESSION_PROMPT_KIND = "session.prompt";
export const SESSION_PROMPT_DISPOSITION_KIND = "session.prompt.disposition";
export const RUNTIME_WORKSPACE_BINDING_ID = "workspace";
export const SESSION_CANCEL_KIND = "session.cancel";
export const RUNTIME_STATUS_KIND = "runtime.status";
export const RUNTIME_LIVENESS_READY_KIND = "runtime.liveness.ready";
export const RUNTIME_HEARTBEAT_KIND = "runtime.heartbeat";
export const RUNTIME_HEARTBEAT_ACK_KIND = "runtime.heartbeat.ack";
export const SESSION_STARTED_KIND = "session.started";
export const SESSION_QUEUED_KIND = "session.queued";
export const AGENT_MESSAGE_DELTA_KIND = "agent.message.delta";
export const AGENT_ACTIVITY_KIND = "agent.activity";
export const AGENT_ACTIVITY_NARRATION_KIND = "agent.activity.narration";
export const AGENT_ACTIVITY_DETAIL_LIMIT = 500_000;
export const AGENT_ACTIVITY_RECORDED_FIELD_LIMIT = 4_000_000;
export const AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT = 6_000_000;
export const AGENT_ACTIVITY_LOCATION_LIMIT = 12;
export const AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT = 1_024;
export const SESSION_COMPLETED_KIND = "session.completed";
export const SESSION_FAILED_KIND = "session.failed";

export const SessionPromptDisposition = Object.freeze({
    Queue: "queue",
    Reject: "reject",
    Steer: "steer",
});

export interface SessionPromptCommand {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly bindingId: string;
    readonly commandId: string;
    readonly directoryId: string;
    readonly disposition: string;
    readonly images: readonly PromptImage[];
    readonly kind: typeof SESSION_PROMPT_KIND;
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly sessionId: string;
    readonly targetCommandId: string;
}

export interface SessionCancelCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_KIND;
    readonly sessionId: string;
}

export interface SessionPromptDispositionCommand {
    readonly commandId: string;
    readonly disposition: typeof SessionPromptDisposition.Steer;
    readonly kind: typeof SESSION_PROMPT_DISPOSITION_KIND;
    readonly sessionId: string;
}

export interface SessionQueuedEvent {
    readonly commandId: string;
    readonly kind: typeof SESSION_QUEUED_KIND;
    readonly sessionId: string;
}

export interface RuntimeStatusEvent {
    readonly kind: typeof RUNTIME_STATUS_KIND;
    readonly online: boolean;
    readonly runtimeId: string;
}

export interface RuntimeLivenessReadyEvent {
    readonly kind: typeof RUNTIME_LIVENESS_READY_KIND;
}

export interface RuntimeHeartbeatEvent {
    readonly heartbeatId: string;
    readonly kind: typeof RUNTIME_HEARTBEAT_KIND;
}

export interface RuntimeHeartbeatAckEvent {
    readonly heartbeatId: string;
    readonly kind: typeof RUNTIME_HEARTBEAT_ACK_KIND;
}

export interface SessionStartedEvent {
    readonly commandId: string;
    readonly epoch: string;
    readonly kind: typeof SESSION_STARTED_KIND;
    readonly attemptId: string;
    readonly prompt: string;
    readonly sequence: 0;
    readonly sessionId: string;
}

export interface AgentMessageDeltaEvent {
    readonly commandId: string;
    readonly epoch: string;
    readonly kind: typeof AGENT_MESSAGE_DELTA_KIND;
    readonly messageId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly text: string;
}

/** A bounded Agent narration increment. Sequence orders activities, not narration chunks. */
export interface AgentActivityNarrationEvent {
    readonly activityId: string;
    readonly activityType: string;
    readonly commandId: string;
    readonly kind: typeof AGENT_ACTIVITY_NARRATION_KIND;
    readonly sequence: number;
    readonly sessionId: string;
    readonly text: string;
}

export interface AgentActivityEvent {
    readonly activityId: string;
    readonly activityType: string;
    readonly commandId: string;
    readonly content: readonly AgentDisplayContent[];
    readonly detail: AgentActivityDetailCapture;
    readonly input: string;
    readonly kind: typeof AGENT_ACTIVITY_KIND;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;
}

export type AgentActivityDetailCapture =
    | {
          readonly artifactId: string;
          readonly kind: "available";
      }
    | {
          readonly content: readonly AgentDisplayContent[];
          readonly input: string;
          readonly kind: "recorded";
          readonly output: string;
      }
    | {
          readonly capturedBytes: number;
          readonly kind: "truncated";
          readonly originalBytes: number;
      }
    | { readonly kind: "unrecorded" };

export interface SessionCompletedEvent {
    readonly commandId: string;
    readonly kind: typeof SESSION_COMPLETED_KIND;
    readonly sessionId: string;
    readonly stopReason: string;
}

export interface SessionFailedEvent {
    readonly code: string;
    readonly commandId: string;
    readonly kind: typeof SESSION_FAILED_KIND;
    readonly message: string;
    readonly sessionId: string;
}

import type { AgentDisplayContent, PromptImage, PromptResource } from "./control-messages.ts";
