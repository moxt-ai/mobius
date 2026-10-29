import { assertKind, parseJson, readBoolean, readIdentifier } from "../shared/message-codec.ts";

export const RUNTIME_STATUS_KIND = "runtime.status";
export const RUNTIME_LIVENESS_READY_KIND = "runtime.liveness.ready";
export const RUNTIME_HEARTBEAT_KIND = "runtime.heartbeat";
export const RUNTIME_HEARTBEAT_ACK_KIND = "runtime.heartbeat.ack";
export const RUNTIME_PING_KIND = "runtime.ping";
export const RUNTIME_PONG_KIND = "runtime.pong";

/**
 * The Relay's host answers this exact text without waking the Relay, so a heartbeat and its
 * acknowledgement carry no per-heartbeat data and must keep this byte-for-byte encoding.
 */
export const RUNTIME_HEARTBEAT_MESSAGE = `{"kind":"${RUNTIME_HEARTBEAT_KIND}"}`;
export const RUNTIME_HEARTBEAT_ACK_MESSAGE = `{"kind":"${RUNTIME_HEARTBEAT_ACK_KIND}"}`;

export interface RuntimeStatusEvent {
    readonly kind: typeof RUNTIME_STATUS_KIND;
    readonly online: boolean;
    readonly runtimeId: string;
}

export interface RuntimeLivenessReadyEvent {
    readonly kind: typeof RUNTIME_LIVENESS_READY_KIND;
}

export interface RuntimeHeartbeatEvent {
    readonly kind: typeof RUNTIME_HEARTBEAT_KIND;
}

export interface RuntimeHeartbeatAckEvent {
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

export function decodeRuntimeStatusEvent(encoded: string): RuntimeStatusEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_STATUS_KIND);

    return {
        kind: RUNTIME_STATUS_KIND,
        online: readBoolean(value, "online"),
        runtimeId: readIdentifier(value, "runtimeId"),
    };
}

export function decodeRuntimeLivenessReadyEvent(encoded: string): RuntimeLivenessReadyEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_LIVENESS_READY_KIND);
    return { kind: RUNTIME_LIVENESS_READY_KIND };
}

export function decodeRuntimeHeartbeatEvent(encoded: string): RuntimeHeartbeatEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_HEARTBEAT_KIND);
    return { kind: RUNTIME_HEARTBEAT_KIND };
}

export function decodeRuntimeHeartbeatAckEvent(encoded: string): RuntimeHeartbeatAckEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_HEARTBEAT_ACK_KIND);
    return { kind: RUNTIME_HEARTBEAT_ACK_KIND };
}

export function decodeRuntimePingCommand(encoded: string): RuntimePingCommand {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_PING_KIND);
    return { kind: RUNTIME_PING_KIND, requestId: readIdentifier(value, "requestId") };
}

export function decodeRuntimePongEvent(encoded: string): RuntimePongEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_PONG_KIND);
    return { kind: RUNTIME_PONG_KIND, requestId: readIdentifier(value, "requestId") };
}

export function encodeRuntimeStatusEvent(message: RuntimeStatusEvent): string {
    return JSON.stringify(decodeRuntimeStatusEvent(JSON.stringify(message)));
}

export function encodeRuntimeLivenessReadyEvent(message: RuntimeLivenessReadyEvent): string {
    return JSON.stringify(decodeRuntimeLivenessReadyEvent(JSON.stringify(message)));
}

export function encodeRuntimeHeartbeatEvent(message: RuntimeHeartbeatEvent): string {
    decodeRuntimeHeartbeatEvent(JSON.stringify(message));
    return RUNTIME_HEARTBEAT_MESSAGE;
}

export function encodeRuntimeHeartbeatAckEvent(message: RuntimeHeartbeatAckEvent): string {
    decodeRuntimeHeartbeatAckEvent(JSON.stringify(message));
    return RUNTIME_HEARTBEAT_ACK_MESSAGE;
}

export function encodeRuntimePingCommand(message: RuntimePingCommand): string {
    return JSON.stringify(decodeRuntimePingCommand(JSON.stringify(message)));
}

export function encodeRuntimePongEvent(message: RuntimePongEvent): string {
    return JSON.stringify(decodeRuntimePongEvent(JSON.stringify(message)));
}
