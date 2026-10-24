import type {
    SessionConfigReadCommand,
    SessionConfigureCommand,
    SessionPrepareCommand,
    SessionReadyEvent,
    SessionRenameCommand,
    SessionRestoreCommand,
    WorkspaceListCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import {
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    SESSION_RENAME_KIND,
    SESSION_RESTORE_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { operationErrorCode } from "../../../infra/operation-error.ts";
import { AccumulatingOperationMetrics } from "../../../infra/operation-metrics.ts";
import type { SessionRecovery } from "../../../session/api/session-api.ts";
import { SessionError } from "../../../session/api/session-error.ts";
import type { ClosedSessionHandling, SessionManager } from "../../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../../session/native/native-session-browser.ts";
import { resolveSessionDirectories } from "../../../session/workspace/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "../../../session/workspace/workspace-directory.ts";
import { resolveCatalogAgent } from "../../catalog/resolve-catalog-agent.ts";
import type { RuntimeConfig } from "../../config.ts";
import type { RelayConnectionDiagnostics } from "../../relay/diagnostics.ts";
import type { RuntimeCommand } from "../definition.ts";
import type { RuntimeCommandTransport } from "../transport.ts";
import { reportOperationFailure, send } from "../transport.ts";

async function prepareSession(
    command: SessionPrepareCommand,
    recovery: SessionRecovery,
    closed: ClosedSessionHandling,
    config: RuntimeConfig,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
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
                  ? await sessions.restoreSession(preparation, metrics, closed)
                  : await sessions.prepareSession(preparation, metrics, closed);
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
    transport: RuntimeCommandTransport,
    command: WorkspaceListCommand,
    directories: WorkspaceDirectoryService,
    signal: AbortSignal,
): Promise<void> {
    try {
        const listing = await directories.list(command.bindingId, command.directoryId, signal);
        send(transport, {
            bindingId: command.bindingId,
            directoryId: listing.directoryId,
            directoryLabel: listing.directoryLabel,
            entries: listing.entries,
            kind: "workspace.entries",
            parentDirectoryId: listing.parentDirectoryId,
            requestId: command.requestId,
        });
    } catch (error) {
        reportOperationFailure(transport, command.requestId, "", error);
    }
}

export async function executeSessionPrepare(
    transport: RuntimeCommandTransport,
    command: SessionPrepareCommand,
    config: RuntimeConfig,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const readyEvent = await prepareSession(
            command,
            { kind: "interactive-only" },
            "reopen",
            config,
            directories,
            sessions,
            metrics,
            signal,
        );
        send(transport, {
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
        reportOperationFailure(transport, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export async function executeSessionRestore(
    transport: RuntimeCommandTransport,
    command: SessionRestoreCommand,
    config: RuntimeConfig,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const entry = await metrics.measure("session-lookup", async () => {
            const [found] = await nativeSessions.querySessions([command.sessionId], signal);
            if (found === undefined) {
                throw new SessionError("session_not_found", "The Session was not found");
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
            "reopen",
            config,
            directories,
            sessions,
            metrics,
            signal,
        );
        send(transport, {
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
        reportOperationFailure(transport, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export async function executeSessionRename(
    transport: RuntimeCommandTransport,
    command: SessionRenameCommand,
    sessions: SessionManager,
    signal: AbortSignal,
): Promise<void> {
    try {
        const renamed = await sessions.renameSession(command.sessionId, command.title, signal);
        send(transport, {
            kind: "session.renamed",
            requestId: command.requestId,
            sessionId: command.sessionId,
            title: renamed.title,
            updatedAt: renamed.updatedAt,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(transport, command.requestId, command.sessionId, error);
    }
}

export async function executeSessionConfigure(
    transport: RuntimeCommandTransport,
    command: SessionConfigureCommand,
    config: RuntimeConfig,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
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
        send(transport, {
            configOptions,
            kind: "session.config.updated",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(transport, command.requestId, command.sessionId, error);
    }
}

export const workspaceListCommand: RuntimeCommand = {
    kind: WORKSPACE_LIST_KIND,
    handle: (context, message): void => {
        if (message.kind !== WORKSPACE_LIST_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeWorkspaceList(context.transport, message, context.directories, context.signal);
    },
};

export const sessionPrepareCommand: RuntimeCommand = {
    kind: SESSION_PREPARE_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_PREPARE_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionPrepare(
            context.transport,
            message,
            context.config,
            context.directories,
            context.sessions,
            context.diagnostics,
            context.signal,
        );
    },
};

export const sessionConfigureCommand: RuntimeCommand = {
    kind: SESSION_CONFIGURE_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_CONFIGURE_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionConfigure(
            context.transport,
            message,
            context.config,
            context.directories,
            context.sessions,
            context.signal,
        );
    },
};

export const sessionRestoreCommand: RuntimeCommand = {
    kind: SESSION_RESTORE_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_RESTORE_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionRestore(
            context.transport,
            message,
            context.config,
            context.directories,
            context.sessions,
            context.nativeSessions,
            context.diagnostics,
            context.signal,
        );
    },
};

export const sessionRenameCommand: RuntimeCommand = {
    kind: SESSION_RENAME_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_RENAME_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionRename(context.transport, message, context.sessions, context.signal);
    },
};

export async function executeSessionConfigRead(
    transport: RuntimeCommandTransport,
    command: SessionConfigReadCommand,
    config: RuntimeConfig,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const entry = await metrics.measure("session-lookup", async () => {
            const [found] = await nativeSessions.querySessions([command.sessionId], signal);
            if (found === undefined) {
                throw new SessionError("session_not_found", "The Session was not found");
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
            // A settings read must not force history loading: Agents without
            // load support would fail even with a live process whose config is
            // already readable, and prepare reuses the current configuration.
            { kind: "interactive-only" },
            // Reading settings must not reopen a Session that a client closed.
            "keep-closed",
            config,
            directories,
            sessions,
            metrics,
            signal,
        );
        send(transport, {
            configOptions: ready.configOptions,
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        diagnostics.daemonDiagnostic(
            "session_config_read_failed",
            command.requestId,
            {
                code: operationErrorCode(error),
                sessionId: command.sessionId,
            },
            error,
        );
        reportOperationFailure(transport, command.requestId, command.sessionId, error, metrics.snapshot());
    }
}

export const sessionConfigReadCommand: RuntimeCommand = {
    kind: SESSION_CONFIG_READ_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_CONFIG_READ_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionConfigRead(
            context.transport,
            message,
            context.config,
            context.directories,
            context.sessions,
            context.nativeSessions,
            context.diagnostics,
            context.signal,
        );
    },
};
