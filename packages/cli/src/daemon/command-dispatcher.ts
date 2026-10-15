import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    type ServiceToDaemonMessage,
    type SessionCancelCommand,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../acp/agent-runtime-manager.ts";
import { LocalAgentCatalogError } from "../agent-catalog/local-agent.ts";
import { LocalAuthorizationError } from "../authorization/local-authorization-error.ts";
import type { DurationMetric } from "../infra/operation-metrics.ts";
import { PromptArtifactError } from "../prompt-artifact-resolver.ts";
import type { DaemonOperationState } from "../relay-connection/daemon-operation-state.ts";
import type { DaemonSessionEventProjectionV2 } from "../session-event-projection-v2.ts";
import type { CommandContext } from "./command/context.ts";
import { createCommandRegistry } from "./command/registry/index.ts";

export type { CommandContext } from "./command/context.ts";

export function createDaemonCommandDispatcher(options: CommandContext): {
    readonly dispatch: (message: ServiceToDaemonMessage) => void;
    readonly settle: () => Promise<void>;
} {
    return createCommandRegistry(options);
}

export function send(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeDaemonToServiceMessage(message));
}

export async function settleAbandonedTurn(
    projection: DaemonSessionEventProjectionV2,
    operations: DaemonOperationState,
    cancellation: SessionCancelCommand,
): Promise<void> {
    const attemptId = operations.findUnsettledAttemptId(cancellation.commandId, cancellation.sessionId);
    if (attemptId === null) {
        console.warn("Mobius daemon ignored cancellation for an inactive turn");
        return;
    }
    await projection.failed(
        cancellation.sessionId,
        cancellation.commandId,
        "agent_execution_abandoned",
        "The local Agent execution was abandoned before it completed",
    );
    operations.transitionExecution(cancellation.commandId, "failed");
    projection.publishTerminal(cancellation.sessionId, cancellation.commandId);
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
