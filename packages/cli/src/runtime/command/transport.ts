import { type DaemonToServiceMessage, encodeDaemonToServiceMessage } from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp/acp-error.ts";
import { LocalAgentCatalogError } from "../../agent/catalog.ts";
import type { DurationMetric } from "../../infra/operation-metrics.ts";
import { PromptArtifactError } from "../session/prompt-artifact-resolver.ts";
import { LocalAuthorizationError } from "../workspace/local-authorization-error.ts";

export function send(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeDaemonToServiceMessage(message));
}

export function operationErrorCode(error: unknown): string {
    return error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof PromptArtifactError
        ? error.code
        : "session_operation_failed";
}

export function operationErrorMessage(error: unknown): string {
    return error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof PromptArtifactError
        ? error.message
        : "The local agent operation could not be completed";
}

export function agentSettingsFailureDetails(agentId: string, failure: unknown): Readonly<Record<string, string>> {
    const details = { agentId, code: operationErrorCode(failure) };
    if (!(failure instanceof AcpConfigurationValueUnavailableError)) {
        return details;
    }
    return {
        ...details,
        configId: failure.configId,
        offeredValueCount: failure.offeredValueCount.toString(),
        offeredValues: JSON.stringify(failure.offeredValues),
        requestedValue: failure.requestedValue,
    };
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
