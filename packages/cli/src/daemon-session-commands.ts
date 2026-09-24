import { basename } from "node:path";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type DaemonToServiceMessage,
    type decodeSessionLiveHistoryLoad,
    type decodeSessionLiveHistoryPageLoad,
    encodeDaemonToServiceMessage,
    type NativeSessionResult,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionCancelCommand,
    type SessionConfigureCommand,
    type SessionPrepareCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionReadyEvent,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import type { AcpActivity } from "./acp/activity.ts";
import {
    agentForSessionConfiguration,
    applyCompleteSessionConfiguration,
    assertAppliedSessionConfiguration,
} from "./acp/session-config/apply-session-configuration.ts";
import {
    AcpConfigurationValueUnavailableError,
    AcpExecutionError,
    type AcpSessionManager,
} from "./acp/session-manager.ts";
import { LocalAgentCatalogError } from "./agent-catalog/local-agent.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { LocalAuthorizationError } from "./authorization/local-authorization-error.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { AccumulatingOperationMetrics, type DurationMetric } from "./infra/operation-metrics.ts";
import { mergeLiveSessionHistory, paginateLiveSessionHistory } from "./native-sessions/live-history-page.ts";
import { PromptArtifactError, resolvePromptArtifacts } from "./prompt-artifact-resolver.ts";
import {
    AGENT_ACTIVITY_COALESCING_MILLISECONDS,
    CoalescingDaemonActivityPublisher,
} from "./relay-connection/coalescing-activity-publisher.ts";
import { CoalescingNarrationPublisher } from "./relay-connection/coalescing-narration-publisher.ts";
import { CoalescingTextPublisher } from "./relay-connection/coalescing-text-publisher.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
import type { DaemonTimer } from "./relay-connection/timer.ts";

const AGENT_TEXT_COALESCING_MILLISECONDS = 100;
// Mirrors the protocol's per-event text limit; larger deltas are rejected by the codec.
const AGENT_TEXT_MAXIMUM_LENGTH = 100_000;

class ResolvedSessionDirectories {
    readonly additionalDirectories: readonly string[];
    readonly additionalDirectoryEntries: readonly {
        readonly directoryId: string;
        readonly name: string;
    }[];
    readonly cwd: string;

    constructor(
        cwd: string,
        additionalDirectories: readonly string[],
        additionalDirectoryEntries: readonly {
            readonly directoryId: string;
            readonly name: string;
        }[],
    ) {
        this.additionalDirectories = additionalDirectories;
        this.additionalDirectoryEntries = additionalDirectoryEntries;
        this.cwd = cwd;
    }
}

export interface DaemonTurnCommand {
    readonly commandId: string;
    readonly sessionId: string;
}

export function send(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeDaemonToServiceMessage(message));
}

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

export function reportFailure(
    publisher: DaemonSessionEventPublisher,
    command: DaemonTurnCommand,
    code: string,
    message: string,
): void {
    publisher.publish(command.sessionId, {
        code,
        commandId: command.commandId,
        kind: SESSION_FAILED_KIND,
        message,
        sessionId: command.sessionId,
    });
}

/**
 * Settles a Turn claimed by this live Runtime when its active process can no longer execute.
 * A lost connection can deliver cancellation after the process has stopped; the in-memory
 * receipt identifies the Attempt that should be reported as failed.
 */
export function settleAbandonedTurn(
    publisher: DaemonSessionEventPublisher,
    operations: DaemonOperationState,
    audit: AuditStore,
    cancellation: SessionCancelCommand,
): void {
    const attemptId = operations.findUnsettledAttemptId(cancellation.commandId, cancellation.sessionId);
    if (attemptId === null) {
        console.warn("Mobius daemon ignored cancellation for an inactive turn");
        return;
    }
    audit.record({
        commandId: cancellation.commandId,
        event: "session_abandoned_turn_settled",
        sessionId: cancellation.sessionId,
    });
    reportFailure(
        publisher,
        cancellation,
        "agent_execution_abandoned",
        "The local Agent execution was abandoned before it completed",
    );
    operations.transitionExecution(cancellation.commandId, "failed");
}

export function operationErrorCode(error: unknown): string {
    if (
        error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof PromptArtifactError
    ) {
        return error.code;
    }
    return "session_operation_failed";
}

export function operationErrorMessage(error: unknown): string {
    if (
        error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof PromptArtifactError
    ) {
        return error.message;
    }
    return "The local agent operation could not be completed";
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

async function resolveSessionDirectories(
    directories: WorkspaceDirectoryService,
    bindingId: string,
    directoryId: string,
    additionalDirectoryIds: readonly string[],
    signal: AbortSignal,
): Promise<ResolvedSessionDirectories> {
    const cwd = await directories.resolve(bindingId, directoryId, signal);
    const additionalDirectories: string[] = [];
    const additionalDirectoryEntries: {
        readonly directoryId: string;
        readonly name: string;
    }[] = [];
    const unique = new Set<string>([cwd]);
    for (const additionalDirectoryId of additionalDirectoryIds) {
        const directory = await directories.resolve(bindingId, additionalDirectoryId, signal);
        if (unique.has(directory)) {
            throw new LocalAuthorizationError("Workspace directories must resolve to distinct locations");
        }
        unique.add(directory);
        additionalDirectories.push(directory);
        additionalDirectoryEntries.push({
            directoryId: additionalDirectoryId,
            name: basename(directory),
        });
    }
    return new ResolvedSessionDirectories(cwd, additionalDirectories, additionalDirectoryEntries);
}

export async function executeWorkspaceList(
    socket: WebSocket,
    command: WorkspaceListCommand,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    signal: AbortSignal,
): Promise<void> {
    try {
        const listing = await directories.list(command.bindingId, command.directoryId, signal);
        audit.record({
            commandId: command.requestId,
            event: "workspace_list_authorized",
            sessionId: "workspace-browser",
        });
        send(socket, {
            bindingId: command.bindingId,
            directoryId: listing.directoryId,
            directoryLabel: listing.directoryLabel,
            entries: listing.entries,
            kind: "workspace.entries",
            parentDirectoryId: listing.parentDirectoryId,
            requestId: command.requestId,
        });
    } catch (error) {
        reportOperationFailure(socket, command.requestId, "", error);
    }
}

export async function executeSessionPrepare(
    publisher: DaemonSessionEventPublisher,
    socket: WebSocket,
    command: SessionPrepareCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const readyEvent = await metrics.measure("prepare-total", async () => {
            const resolved = await metrics.measure(
                "workspace-resolve",
                async () =>
                    await resolveSessionDirectories(
                        directories,
                        config.bindingId,
                        command.directoryId,
                        command.additionalDirectoryIds,
                        signal,
                    ),
            );
            const agent = config.catalog.find(command.agentId);
            const preparation = {
                additionalDirectories: resolved.additionalDirectories,
                agent,
                cwd: resolved.cwd,
                sessionId: command.sessionId,
                signal,
            };
            const prepared =
                command.transient === true
                    ? await sessions.inspectSession(preparation, metrics)
                    : await sessions.prepareSession(preparation, metrics);
            const configuration = command.configuration;
            const configOptions =
                configuration === undefined
                    ? prepared.configOptions
                    : await metrics.measure(
                          "configuration",
                          async () =>
                              await sessions.configureSession({
                                  ...preparation,
                                  booleanValue: configuration.booleanValue,
                                  configId: configuration.configId,
                                  requestId: command.requestId,
                                  value: configuration.value,
                                  valueType: configuration.valueType,
                              }),
                      );
            const listing = await metrics.measure(
                "workspace-list",
                async () => await directories.list(config.bindingId, command.directoryId, signal),
            );
            audit.record({
                commandId: command.requestId,
                event: "session_prepared",
                sessionId: command.sessionId,
            });
            if (command.configuration !== undefined) {
                audit.record({
                    commandId: command.requestId,
                    event: "session_configured",
                    sessionId: command.sessionId,
                });
                publisher.publish(command.sessionId, {
                    configOptions,
                    kind: "session.config.updated",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                });
            }
            const event: SessionReadyEvent = {
                additionalDirectories: resolved.additionalDirectoryEntries,
                agentId: command.agentId,
                agentName: prepared.agentName,
                agentVersion: prepared.agentVersion,
                capabilities: prepared.capabilities,
                commands: prepared.commands,
                configOptions,
                directoryId: command.directoryId,
                directoryLabel: listing.directoryLabel,
                kind: "session.ready",
                requestId: command.requestId,
                restored: prepared.restored,
                sessionId: command.sessionId,
                runtimeTimings: metrics.snapshot(),
            };
            // Inspection-only preparation returns readiness to its caller without broadcasting it.
            if (command.transient !== true) {
                metrics.measureSync("readiness-commit", () => {
                    publisher.publish(command.sessionId, event);
                });
            }
            return event;
        });
        send(socket, {
            ...readyEvent,
            runtimeTimings: metrics.snapshot(),
        });
    } catch (error) {
        audit.record({
            commandId: command.requestId,
            details: {
                agentId: command.agentId,
                code: operationErrorCode(error),
            },
            event: "session_prepare_failed",
            sessionId: command.sessionId,
        });
        reportOperationFailure(socket, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export async function executeSessionLiveHistoryLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    activeTurn: (sessionId: string) => Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"],
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const history = await sessions.loadSessionHistory({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        });
        signal.throwIfAborted();
        const mergedHistory = mergeLiveSessionHistory(history, activeTurn(command.sessionId), command.sessionId);
        audit.record({
            commandId: command.requestId,
            event: "session_history_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            history: mergedHistory,
            kind: "session.live-history.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        audit.record({
            commandId: command.requestId,
            details: { code: operationErrorCode(error) },
            event: "session_history_unavailable",
            sessionId: command.sessionId,
        });
        send(socket, {
            history: {
                status: "unavailable",
                cause: { code: operationErrorCode(error), message: operationErrorMessage(error) },
            },
            kind: "session.live-history.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    }
}

export async function executeSessionLiveHistoryPageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryPageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    activeTurn: (sessionId: string) => Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"],
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const history = await sessions.loadSessionHistory({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        });
        signal.throwIfAborted();
        const page = paginateLiveSessionHistory(
            history,
            activeTurn(command.sessionId),
            command.sessionId,
            command.cursor,
            command.limit,
        );
        audit.record({
            commandId: command.requestId,
            event: "session_history_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            kind: "session.live-history.page.loaded",
            page,
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        audit.record({
            commandId: command.requestId,
            details: { code: operationErrorCode(error) },
            event: "session_history_unavailable",
            sessionId: command.sessionId,
        });
        send(socket, {
            kind: "session.live-history.page.loaded",
            page: {
                status: "unavailable",
                cause: { code: operationErrorCode(error), message: operationErrorMessage(error) },
                nextCursor: null,
            },
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    }
}

export async function executeSessionConfigure(
    publisher: DaemonSessionEventPublisher,
    socket: WebSocket,
    command: SessionConfigureCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const configOptions = await sessions.configureSession({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            booleanValue: command.booleanValue,
            configId: command.configId,
            cwd: resolved.cwd,
            requestId: command.requestId,
            sessionId: command.sessionId,
            signal,
            value: command.value,
            valueType: command.valueType,
        });
        audit.record({
            commandId: command.requestId,
            event: "session_configured",
            sessionId: command.sessionId,
        });
        publisher.publish(command.sessionId, {
            configOptions,
            kind: "session.config.updated",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(socket, command.requestId, command.sessionId, error);
    }
}

export async function executePrompt(
    operations: DaemonOperationState,
    publisher: DaemonSessionEventPublisher,
    command: SessionPromptCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    attemptId: string,
    activateAttempt: () => { readonly epoch: string; readonly sequence: 0 },
    acknowledgeQueued: () => void,
    waitForSessionAvailability: (
        signal: AbortSignal,
    ) => Promise<
        | { readonly kind: "available"; readonly disposition: string }
        | { readonly kind: "busy" }
        | { readonly kind: "queue-target-unavailable" }
    >,
    timer: DaemonTimer,
    signal: AbortSignal,
    recordLiveEvent: (
        event:
            | { readonly kind: typeof AGENT_MESSAGE_DELTA_KIND; readonly messageId: string; readonly text: string }
            | Exclude<RecordedSessionEvent, { readonly kind: typeof AGENT_MESSAGE_DELTA_KIND }>,
    ) => RecordedSessionEvent,
    cancellationRequested: () => boolean,
): Promise<void> {
    const narration = new CoalescingNarrationPublisher(
        timer,
        (increment) => {
            const event: RecordedSessionEvent = {
                activityId: increment.activityId,
                activityType: increment.activityType,
                commandId: command.commandId,
                kind: AGENT_ACTIVITY_NARRATION_KIND,
                sequence: increment.sequence,
                sessionId: command.sessionId,
                text: increment.text,
            };
            publisher.publish(command.sessionId, recordLiveEvent(event));
        },
        AGENT_ACTIVITY_COALESCING_MILLISECONDS,
        AGENT_TEXT_MAXIMUM_LENGTH,
    );
    const activities = new CoalescingDaemonActivityPublisher(timer, (activity) => {
        if (activity.status !== "pending" && activity.status !== "running") {
            narration.flush();
        }
        const event = daemonActivity(command, activity);
        publisher.publish(command.sessionId, recordLiveEvent(event));
    });
    const text = new CoalescingTextPublisher(
        timer,
        (messageId, delta) => {
            publisher.publish(
                command.sessionId,
                recordLiveEvent({ kind: AGENT_MESSAGE_DELTA_KIND, messageId, text: delta }),
            );
        },
        AGENT_TEXT_COALESCING_MILLISECONDS,
        AGENT_TEXT_MAXIMUM_LENGTH,
    );
    try {
        if (command.disposition === SessionPromptDisposition.Queue) {
            acknowledgeQueued();
        }
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
        if (command.sessionConfigurations !== undefined) {
            const prepared = await sessions.prepareExecutionSession({
                additionalDirectories: resolved.additionalDirectories,
                agent: executionAgent,
                cwd: resolved.cwd,
                sessionId: command.sessionId,
                signal,
            });
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
            }
        }
        audit.record({
            commandId: command.commandId,
            event: "session_authorized",
            sessionId: command.sessionId,
        });
        operations.transitionExecution(command.commandId, "running");
        const stream = activateAttempt();
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
                onActivity: activities.record,
                onNarration: (increment) => {
                    narration.record(increment);
                    return Promise.resolve();
                },
                onText: (delta, messageId) => {
                    text.record(messageId, delta);
                    return Promise.resolve();
                },
                prompt: command.prompt,
                resources: attachments.resources,
                sessionId: command.sessionId,
                signal,
                targetCommandId: command.targetCommandId,
            });
            stopReason = result.stopReason;
        }

        text.flush();
        narration.flush();
        activities.flush();
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
        text.flush();
        narration.flush();
        activities.flush();
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
