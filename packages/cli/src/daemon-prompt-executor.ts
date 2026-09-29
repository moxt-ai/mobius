import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_READY_KIND,
    SESSION_STARTED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import type { AcpActivity } from "./acp/activity.ts";
import { AcpExecutionError, type AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import {
    agentForSessionConfiguration,
    applyCompleteSessionConfiguration,
    assertAppliedSessionConfiguration,
} from "./acp/session-config/apply-session-configuration.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import {
    type DaemonTurnCommand,
    operationErrorCode,
    operationErrorMessage,
    reportFailure,
} from "./daemon-command-results.ts";
import { resolvePromptArtifacts } from "./prompt-artifact-resolver.ts";
import { CoalescingAgentEventPublisher } from "./relay-connection/coalescing-agent-event-publisher.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
import type { DaemonTimer } from "./relay-connection/timer.ts";

function daemonActivity(command: DaemonTurnCommand, activity: AcpActivity): AgentActivityEvent {
    return {
        activityId: activity.activityId,
        activityType: activity.activityType,
        commandId: command.commandId,
        content: activity.content,
        detail: activity.detail,
        input: activity.input,
        kind: AGENT_ACTIVITY_KIND,
        locations: activity.locations,
        name: activity.name,
        output: activity.output,
        sequence: activity.sequence,
        sessionId: command.sessionId,
        status: activity.status,
        title: activity.title,
        toolKind: activity.toolKind,
    };
}

export interface ExecutePromptOptions {
    readonly operations: DaemonOperationState;
    readonly publisher: DaemonSessionEventPublisher;
    readonly command: SessionPromptCommand;
    readonly config: DaemonConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly audit: AuditStore;
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
    readonly timer: DaemonTimer;
    readonly signal: AbortSignal;
    readonly recordLiveEvent: (
        event:
            | { readonly kind: typeof AGENT_MESSAGE_DELTA_KIND; readonly messageId: string; readonly text: string }
            | Exclude<RecordedSessionEvent, { readonly kind: typeof AGENT_MESSAGE_DELTA_KIND }>,
    ) => RecordedSessionEvent;
    readonly recordSteeringPrompt: () => boolean;
    readonly cancellationRequested: () => boolean;
}

export async function executePrompt({
    operations,
    publisher,
    command,
    config,
    directories,
    audit,
    sessions,
    attemptId,
    activateAttempt,
    waitForSessionAvailability,
    timer,
    signal,
    recordLiveEvent,
    recordSteeringPrompt,
    cancellationRequested,
}: ExecutePromptOptions): Promise<void> {
    const events = new CoalescingAgentEventPublisher(timer, (event) => {
        if (event.kind === "text") {
            publisher.publish(
                command.sessionId,
                recordLiveEvent({ kind: AGENT_MESSAGE_DELTA_KIND, messageId: event.messageId, text: event.text }),
            );
            return;
        }
        if (event.kind === "narration") {
            const recorded: RecordedSessionEvent = {
                activityId: event.increment.activityId,
                activityType: event.increment.activityType,
                commandId: command.commandId,
                kind: AGENT_ACTIVITY_NARRATION_KIND,
                sequence: event.increment.sequence,
                sessionId: command.sessionId,
                text: event.increment.text,
            };
            publisher.publish(command.sessionId, recordLiveEvent(recorded));
            return;
        }
        const activity = daemonActivity(command, event.activity);
        publisher.publish(command.sessionId, recordLiveEvent(activity));
    });
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            command.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const agent = config.catalog.find(command.agentId);
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
                    audit,
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
        audit.record({
            commandId: command.commandId,
            event: "session_authorized",
            sessionId: command.sessionId,
        });
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
        if (!prepared.prompted) {
            const listing = await directories.list(config.bindingId, command.directoryId, signal);
            publisher.publish(command.sessionId, {
                additionalDirectories: resolved.additionalDirectoryEntries,
                agentId: command.agentId,
                agentName: prepared.agentName,
                agentVersion: prepared.agentVersion,
                capabilities: prepared.capabilities,
                commands: prepared.commands,
                configOptions: prepared.configOptions,
                directoryId: command.directoryId,
                directoryLabel: listing.directoryLabel,
                kind: SESSION_READY_KIND,
                requestId: command.commandId,
                restored: prepared.restored,
                sessionId: command.sessionId,
            });
        }
        publisher.publish(command.sessionId, {
            commandId: command.commandId,
            epoch: stream.epoch,
            kind: SESSION_STARTED_KIND,
            attemptId,
            prompt: command.prompt,
            sequence: stream.sequence,
            sessionId: command.sessionId,
        });
        const attachments = await resolvePromptArtifacts(config, command, signal);
        let stopReason: string;
        if (availability.disposition === SessionPromptDisposition.Steer) {
            await sessions.steerPrompt({
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
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
                onActivity: events.recordActivity,
                onNarration: events.recordNarration,
                onText: events.recordText,
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
            });
            stopReason = result.stopReason;
        }

        events.flush();
        publisher.publish(command.sessionId, {
            commandId: command.commandId,
            kind: SESSION_COMPLETED_KIND,
            sessionId: command.sessionId,
            stopReason,
        });
        operations.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
        audit.record({
            commandId: command.commandId,
            event: stopReason === "cancelled" ? "session_cancelled" : "session_completed",
            sessionId: command.sessionId,
        });
    } catch (error) {
        events.flush();
        if (signal.aborted && cancellationRequested()) {
            publisher.publish(command.sessionId, {
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: command.sessionId,
                stopReason: "cancelled",
            });
            operations.transitionExecution(command.commandId, "cancelled");
            audit.record({
                commandId: command.commandId,
                event: "session_cancelled",
                sessionId: command.sessionId,
            });
            return;
        }
        audit.record({
            commandId: command.commandId,
            event: "session_failed",
            sessionId: command.sessionId,
        });
        const code = operationErrorCode(error);
        reportFailure(
            publisher,
            command,
            code === "session_operation_failed" ? "agent_execution_failed" : code,
            code === "session_operation_failed"
                ? "The local agent could not complete the request"
                : operationErrorMessage(error),
        );
        operations.transitionExecution(command.commandId, "failed");
        console.error("Mobius daemon command failed", error);
    }
}
