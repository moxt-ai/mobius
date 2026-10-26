import {
    SessionHistoryPolicy,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { ReportFailure, ResolveAgent } from "../api/session-api.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import type { ExecutionReceipts } from "../turn/execution-receipts.ts";
import { resolveSessionDirectories } from "../workspace/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import {
    agentForSessionConfiguration,
    applyCompleteSessionConfiguration,
    assertAppliedSessionConfiguration,
} from "./apply-session-configuration.ts";
import { type DownloadArtifact, resolvePromptArtifacts } from "./prompt-artifacts.ts";
import type { PromptLifecycle } from "./prompt-lifecycle.ts";

export interface ExecutePromptOptions {
    readonly operations: ExecutionReceipts;
    readonly eventProjection: PromptLifecycle;
    readonly command: SessionPromptCommand;
    readonly resolveAgent: ResolveAgent;
    readonly downloadArtifact: DownloadArtifact;
    readonly reportFailure: ReportFailure;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
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
    readonly recordSteeringPrompt: () => boolean;
    readonly cancellationRequested: () => boolean;
}

export async function executePrompt({
    operations,
    eventProjection,
    command,
    resolveAgent,
    downloadArtifact,
    reportFailure,
    directories,
    sessions,
    attemptId,
    activateAttempt,
    waitForSessionAvailability,
    signal,
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
        const { agent, adapter } = await resolveAgent(command.agentId, signal);
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
        const recovery =
            command.historyPolicy === SessionHistoryPolicy.ExecutionOnly
                ? ({ kind: "execution-only" } as const)
                : ({ kind: "interactive-only" } as const);
        const preparation = {
            adapter,
            additionalDirectories: resolved.additionalDirectories,
            agent: executionAgent,
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
            recovery,
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
                    adapter,
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
        const lifecycle = eventProjection.started(
            command.sessionId,
            command.commandId,
            attemptId,
            stream.epoch,
            availability.disposition,
        );
        const attachments = await resolvePromptArtifacts(downloadArtifact, command, signal);
        let stopReason: string;
        if (availability.disposition === SessionPromptDisposition.Steer) {
            await sessions.steerPrompt({
                adapter,
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
                lifecycle,
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
            });
            stopReason = "steered";
        } else {
            const result = await sessions.runPrompt({
                adapter,
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                disposition: availability.disposition,
                images: attachments.images,
                lifecycle,
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
                recovery,
            });
            stopReason = result.stopReason;
        }

        await eventProjection.completed(command.sessionId, command.commandId, stopReason);
        operations.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
    } catch (error) {
        if (signal.aborted && cancellationRequested()) {
            await eventProjection.completed(command.sessionId, command.commandId, "cancelled");
            operations.transitionExecution(command.commandId, "cancelled");
            return;
        }
        const code = operationErrorCode(error);
        const failureCode = code === "session_operation_failed" ? "agent_execution_failed" : code;
        const failureMessage =
            code === "session_operation_failed"
                ? "The local agent could not complete the request"
                : operationErrorMessage(error);
        await eventProjection.failed(command.sessionId, command.commandId, failureCode, failureMessage);
        operations.transitionExecution(command.commandId, "failed");
        // The daemon runs detached with its stdio ignored, so a failure recorded
        // only here would leave no trace for a later bug report. The local log is
        // the durable copy; the in-band failure event above stays the live signal.
        //
        // Only the controlled code and correlation identifiers are persisted. An
        // Agent rejection can quote the prompt it refused, and local diagnostics
        // must not contain prompt text, so the Agent's free text and the cause
        // chain deliberately stay out of the log. The message still reaches the
        // user through the failure event above.
        reportFailure("session_prompt_failed", command.commandId, {
            agentId: command.agentId,
            code: failureCode,
            commandId: command.commandId,
            sessionId: command.sessionId,
        });
        console.error("Mobius daemon command failed", error);
    }
}
