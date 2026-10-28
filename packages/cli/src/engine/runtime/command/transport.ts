import {
    type DaemonToServiceMessage,
    encodeContentChunkFrame,
    encodeDaemonToServiceMessage,
} from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";

import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { DurationMetric } from "../../infra/operation-metrics.ts";

export function send(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeDaemonToServiceMessage(message));
}

export function sendContentChunk(socket: WebSocket, requestId: string, sequence: number, bytes: Uint8Array): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeContentChunkFrame({ bytes, requestId, sequence }));
}

export function reportOperationFailure(
    socket: WebSocket,
    requestId: string,
    sessionId: string,
    error: unknown,
    runtimeTimings: readonly DurationMetric[] = [],
): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    send(socket, {
        code: operationErrorCode(error),
        kind: "session.operation.failed",
        message: operationErrorMessage(error),
        requestId,
        ...(runtimeTimings.length === 0 ? {} : { runtimeTimings }),
        sessionId,
    });
}
