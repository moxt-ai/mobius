import type {
    SessionConfigureCommand,
    SessionPrepareCommand,
    SessionReadyEvent,
    SessionRestoreCommand,
    WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import { AcpExecutionError } from "./acp/acp-error.ts";
import type { AcpSessionRecovery, AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { AcpAgentDefinition, DaemonConfig } from "./config.ts";
import { operationErrorCode, reportOperationFailure, send } from "./daemon-command-results.ts";
import { AccumulatingOperationMetrics } from "./infra/operation-metrics.ts";
import type { NativeSessionService } from "./native-sessions/service.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";

export async function resolveCatalogAgent(
    config: DaemonConfig,
    agentId: string,
    signal: AbortSignal,
): Promise<AcpAgentDefinition> {
    const agent = config.catalog.find(agentId);
    return config.resolveAgent === undefined ? agent : await config.resolveAgent(agent, signal);
}

async function prepareSession(
    command: SessionPrepareCommand,
    recovery: AcpSessionRecovery,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    sessions: AgentRuntimeManager,
    metrics: AccumulatingOperationMetrics,
    signal: AbortSignal,
): Promise<SessionReadyEvent> {
    return await metrics.measure("prepare-total", async () => {
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
        const agent = await resolveCatalogAgent(config, command.agentId, signal);
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
                : recovery.kind === "history-required"
                  ? await sessions.restoreSession(preparation, metrics)
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
        return {
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
        };
    });
}

export async function executeWorkspaceList(
    socket: WebSocket,
    command: WorkspaceListCommand,
    directories: WorkspaceDirectoryService,
    signal: AbortSignal,
): Promise<void> {
    try {
        const listing = await directories.list(command.bindingId, command.directoryId, signal);
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
    socket: WebSocket,
    command: SessionPrepareCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    sessions: AgentRuntimeManager,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const readyEvent = await prepareSession(
            command,
            { kind: "interactive-only" },
            config,
            directories,
            sessions,
            metrics,
            signal,
        );
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
        reportOperationFailure(socket, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export async function executeSessionRestore(
    socket: WebSocket,
    command: SessionRestoreCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    sessions: AgentRuntimeManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const entry = await metrics.measure("session-lookup", async () => {
            const [found] = await nativeSessions.querySessions([command.sessionId], signal);
            if (found === undefined) {
                throw new AcpExecutionError("The Session was not found", {}, "session_not_found");
            }
            return found;
        });
        const ready = await prepareSession(
            {
                additionalDirectoryIds: entry.additionalDirectories.map((directory) => directory.directoryId),
                agentId: entry.agentId,
                bindingId: config.bindingId,
                directoryId: entry.directoryId,
                kind: "session.prepare",
                requestId: command.requestId,
                sessionId: command.sessionId,
                sessionState: "provisioned",
            },
            { kind: "history-required" },
            config,
            directories,
            sessions,
            metrics,
            signal,
        );
        send(socket, {
            entry,
            kind: "session.restored",
            ready: { ...ready, runtimeTimings: metrics.snapshot() },
            requestId: command.requestId,
        });
    } catch (error) {
        diagnostics.daemonDiagnostic(
            "session_restore_failed",
            command.requestId,
            {
                code: operationErrorCode(error),
                sessionId: command.sessionId,
            },
            error,
        );
        reportOperationFailure(socket, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export async function executeSessionConfigure(
    socket: WebSocket,
    command: SessionConfigureCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
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
            agent: await resolveCatalogAgent(config, command.agentId, signal),
            booleanValue: command.booleanValue,
            configId: command.configId,
            cwd: resolved.cwd,
            requestId: command.requestId,
            sessionId: command.sessionId,
            signal,
            value: command.value,
            valueType: command.valueType,
        });
        send(socket, {
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
