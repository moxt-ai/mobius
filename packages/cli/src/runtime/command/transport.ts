import { type DaemonToServiceMessage, encodeDaemonToServiceMessage } from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";

import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { DurationMetric } from "../../infra/operation-metrics.ts";

export interface RuntimeCommandTransport {
    readonly isOpen: () => boolean;
    readonly send: (message: DaemonToServiceMessage) => void;
}

export function webSocketCommandTransport(socket: WebSocket): RuntimeCommandTransport {
    return {
        isOpen: () => socket.readyState === WebSocket.OPEN,
        send: (message) => socket.send(encodeDaemonToServiceMessage(message)),
    };
}

export function send(transport: RuntimeCommandTransport, message: DaemonToServiceMessage): void {
    if (!transport.isOpen()) {
        throw new Error("The command connection is not open");
    }
    transport.send(message);
}

export function reportOperationFailure(
    transport: RuntimeCommandTransport,
    requestId: string,
    sessionId: string,
    error: unknown,
    runtimeTimings: readonly DurationMetric[] = [],
): void {
    if (!transport.isOpen()) {
        return;
    }
    send(transport, {
        code: operationErrorCode(error),
        kind: "session.operation.failed",
        message: operationErrorMessage(error),
        requestId,
        ...(runtimeTimings.length === 0 ? {} : { runtimeTimings }),
        sessionId,
    });
}
