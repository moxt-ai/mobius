import type { PromptImage, PromptResource, SessionConfigurationSelection } from "./control-messages.ts";

export const SESSION_PROMPT_KIND = "session.prompt";
export const SESSION_PROMPT_DISPOSITION_KIND = "session.prompt.disposition";
export const RUNTIME_WORKSPACE_BINDING_ID = "workspace";
export const SESSION_CANCEL_KIND = "session.cancel";
export const RUNTIME_STATUS_KIND = "runtime.status";
export const RUNTIME_LIVENESS_READY_KIND = "runtime.liveness.ready";
export const RUNTIME_HEARTBEAT_KIND = "runtime.heartbeat";
export const RUNTIME_HEARTBEAT_ACK_KIND = "runtime.heartbeat.ack";
export const RUNTIME_PING_KIND = "runtime.ping";
export const RUNTIME_PONG_KIND = "runtime.pong";

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

export interface RuntimePingCommand {
    readonly kind: typeof RUNTIME_PING_KIND;
    readonly requestId: string;
}

export interface RuntimePongEvent {
    readonly kind: typeof RUNTIME_PONG_KIND;
    readonly requestId: string;
}
