import type {
    SessionConfigureCommand,
    SessionPrepareCommand,
    SessionReadyEvent,
    WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { operationErrorCode, reportOperationFailure, send } from "./daemon-command-results.ts";
import { AccumulatingOperationMetrics } from "./infra/operation-metrics.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
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
    sessions: AgentRuntimeManager,
    diagnostics: RelayConnectionDiagnostics,
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
        diagnostics.daemonDiagnostic(
            "session_prepare_failed",
            command.requestId,
            {
                agentId: command.agentId,
                code: operationErrorCode(error),
                sessionId: command.sessionId,
            },
            error,
        );
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

export async function executeSessionConfigure(
    publisher: DaemonSessionEventPublisher,
    socket: WebSocket,
    command: SessionConfigureCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AgentRuntimeManager,
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
