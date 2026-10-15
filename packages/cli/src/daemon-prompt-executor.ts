import { type SessionPromptCommand, SessionPromptDisposition } from "@moxt-ai/mobius-protocol";
import type { AcpActivity, AcpActivityNarration } from "./acp/activity.ts";
import { AcpExecutionError, type AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import {
    agentForSessionConfiguration,
    applyCompleteSessionConfiguration,
    assertAppliedSessionConfiguration,
} from "./acp/session-config/apply-session-configuration.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { operationErrorCode, operationErrorMessage } from "./daemon-command-results.ts";
import { resolveCatalogAgent } from "./daemon-session-commands.ts";
import { resolvePromptArtifacts } from "./prompt-artifact-resolver.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import type { DaemonSessionEventProjectionV2 } from "./session-event-projection-v2.ts";

export interface ExecutePromptOptions {
    readonly operations: DaemonOperationState;
    readonly eventProjectionV2: DaemonSessionEventProjectionV2;
    readonly command: SessionPromptCommand;
    readonly config: DaemonConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly attemptId: string;
    readonly activateAttempt: () => { readonly epoch: string; readonly sequence: 0 };
    readonly waitForSessionAvailability: (
        signal: AbortSignal,
    ) => Promise<
        | { readonly kind: "available"; readonly disposition: string }
        | { readonly kind: "busy" }
        | { readonly kind: "queue-target-unavailable" }
    >;
    readonly signal: AbortSignal;
    readonly recordTurnActivity: (activity: AcpActivity) => void;
    readonly recordTurnNarration: (narration: AcpActivityNarration) => void;
    readonly recordTurnText: (messageId: string, text: string) => void;
    readonly recordSteeringPrompt: () => boolean;
    readonly cancellationRequested: () => boolean;
}

export async function executePrompt({
    operations,
    eventProjectionV2,
    command,
    config,
    directories,
    sessions,
    attemptId,
    activateAttempt,
    waitForSessionAvailability,
    signal,
    recordTurnActivity,
    recordTurnNarration,
    recordTurnText,
    recordSteeringPrompt,
    cancellationRequested,
}: ExecutePromptOptions): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            command.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const agent = await resolveCatalogAgent(config, command.agentId, signal);
        const availability = await waitForSessionAvailability(signal);
        if (availability.kind === "busy") {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        if (availability.kind === "queue-target-unavailable") {
            throw new AcpExecutionError(
                "The queued prompt target is unavailable",
                {},
                "prompt_queue_target_unavailable",
            );
        }
        const appliedSettings =
            command.sessionConfigurations === undefined
                ? undefined
                : agentForSessionConfiguration(agent, command.sessionConfigurations);
        const executionAgent = appliedSettings?.agent ?? agent;
        const sessionConfigurations = appliedSettings?.sessionConfigurations;
        const preparation = {
            additionalDirectories: resolved.additionalDirectories,
            agent: executionAgent,
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        };
        let prepared = await sessions.prepareExecutionSession(preparation);
        if (command.sessionConfigurations !== undefined) {
            if (availability.disposition === SessionPromptDisposition.Steer) {
                // Steering cannot reconfigure a running Agent, so the Turn snapshot
                // only has to agree with the settings this live Session exposes. The
                // snapshot comes from Agent settings discovery, so it may name options
                // that the running Session does not expose at all.
                assertAppliedSessionConfiguration(prepared.configOptions, sessionConfigurations ?? []);
            } else {
                await applyCompleteSessionConfiguration(
                    sessions,
                    prepared.configOptions,
                    sessionConfigurations ?? [],
                    executionAgent,
                    resolved.cwd,
                    resolved.additionalDirectories,
                    command.commandId,
                    command.sessionId,
                    signal,
                );
                prepared = await sessions.prepareExecutionSession(preparation);
            }
        }
        operations.transitionExecution(command.commandId, "running");
        if (availability.disposition === SessionPromptDisposition.Steer) {
            if (!recordSteeringPrompt()) {
                throw new AcpExecutionError(
                    "The steering target is unavailable",
                    {},
                    "prompt_queue_target_unavailable",
                );
            }
        }
        const stream = activateAttempt();
        const lifecycleV2 = eventProjectionV2.started(
            command.sessionId,
            command.commandId,
            attemptId,
            stream.epoch,
            availability.disposition,
        );
        const attachments = await resolvePromptArtifacts(config, command, signal);
        let stopReason: string;
        if (availability.disposition === SessionPromptDisposition.Steer) {
            await sessions.steerPrompt({
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
                lifecycleV2,
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
            });
            stopReason = "steered";
        } else {
            const result = await sessions.runPrompt({
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                disposition: availability.disposition,
                images: attachments.images,
                lifecycleV2,
                onActivity: async (activity) => {
                    recordTurnActivity(activity);
                },
                onNarration: async (increment) => {
                    recordTurnNarration(increment);
                },
                onText: async (text, messageId) => {
                    recordTurnText(messageId, text);
                },
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
            });
            stopReason = result.stopReason;
        }

        await eventProjectionV2.completed(command.sessionId, command.commandId, stopReason);
        operations.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
    } catch (error) {
        if (signal.aborted && cancellationRequested()) {
            await eventProjectionV2.completed(command.sessionId, command.commandId, "cancelled");
            operations.transitionExecution(command.commandId, "cancelled");
            return;
        }
        const code = operationErrorCode(error);
        const failureCode = code === "session_operation_failed" ? "agent_execution_failed" : code;
        const failureMessage =
            code === "session_operation_failed"
                ? "The local agent could not complete the request"
                : operationErrorMessage(error);
        await eventProjectionV2.failed(command.sessionId, command.commandId, failureCode, failureMessage);
        operations.transitionExecution(command.commandId, "failed");
        console.error("Mobius daemon command failed", error);
    }
}
