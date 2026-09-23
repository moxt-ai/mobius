import type { SessionConfigurationSelection } from "./control-messages.ts";

export const SESSION_PROMPT_KIND = "session.prompt";
export const RUNTIME_WORKSPACE_BINDING_ID = "workspace";
export const SESSION_CANCEL_KIND = "session.cancel";
export const RUNTIME_STATUS_KIND = "runtime.status";
export const RUNTIME_LIVENESS_READY_KIND = "runtime.liveness.ready";
export const RUNTIME_HEARTBEAT_KIND = "runtime.heartbeat";
export const RUNTIME_HEARTBEAT_ACK_KIND = "runtime.heartbeat.ack";
export const RUNTIME_DELIVERY_KIND = "runtime.delivery";
export const RUNTIME_DELIVERY_RECEIVED_KIND = "runtime.delivery.received";
export const RUNTIME_DELIVERY_COMMITTED_KIND = "runtime.delivery.committed";
export const SESSION_STARTED_KIND = "session.started";
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

export interface RuntimeDelivery {
    readonly deliveryId: string;
    readonly kind: typeof RUNTIME_DELIVERY_KIND;
    readonly payload: string;
    readonly sessionId: string;
}

export interface RuntimeDeliveryReceived {
    readonly deliveryId: string;
    readonly kind: typeof RUNTIME_DELIVERY_RECEIVED_KIND;
    readonly sessionId: string;
}

export interface RuntimeDeliveryCommitted {
    readonly deliveryId: string;
    readonly kind: typeof RUNTIME_DELIVERY_COMMITTED_KIND;
    readonly sessionId: string;
}

export interface SessionStartedEvent {
    readonly commandId: string;
    readonly kind: typeof SESSION_STARTED_KIND;
    readonly attemptId: string;
    readonly sessionId: string;
}

export interface AgentMessageDeltaEvent {
    readonly commandId: string;
    readonly kind: typeof AGENT_MESSAGE_DELTA_KIND;
    readonly messageId: string;
    readonly sessionId: string;
    readonly text: string;
}

/**
 * An incremental append to a streaming narration activity (reasoning or progress).
 *
 * A narration activity is rewritten once per streamed Agent chunk. Sending the
 * accumulated text each time made the durable event stream quadratic in the
 * length of the narration, so only the newly produced text travels here. The
 * receiver appends `text` to what it already holds for `activityId`; the owning
 * Attempt's contiguous source sequence orders the appends, so no offset has to
 * be trusted. The fields carried here are what the receiver needs to render the
 * activity while it is still streaming.
 */
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
