import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-protocol";
import {
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    encodeSessionPromptCommand,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_QUEUED_KIND,
    SessionPromptDisposition,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import type { AcpSessionManager } from "./acp/session-manager.ts";
import { createAgentCatalogRefreshHandler } from "./agent-catalog/handle-agent-catalog-refresh.ts";
import { createAgentSettingsDiscoveryHandler } from "./agent-catalog/handle-agent-settings-discovery.ts";
import type { AgentInstallationManager } from "./agent-installation/agent-installation-manager.ts";
import { streamLocalFile } from "./artifacts/local-file-streamer.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { reportOperationFailure, send, settleAbandonedTurn } from "./daemon-command-results.ts";
import { executeSessionLiveHistoryLoad, executeSessionLiveHistoryPageLoad } from "./daemon-history-commands.ts";
import { executePrompt } from "./daemon-prompt-executor.ts";
import { executeSessionConfigure, executeSessionPrepare, executeWorkspaceList } from "./daemon-session-commands.ts";
import type { DaemonTurnRegistry } from "./daemon-turn-registry.ts";
import { createNativeSessionRequestHandler } from "./native-sessions/handle-native-requests.ts";
import type { NativeSessionService } from "./native-sessions/service.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
import type { DaemonTimer } from "./relay-connection/timer.ts";
export interface DaemonCommandOptions {
    readonly config: DaemonConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly audit: AuditStore;
    readonly sessions: AcpSessionManager;
    readonly installations: AgentInstallationManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: DaemonOperationState;
    readonly publisher: DaemonSessionEventPublisher;
    readonly activeTurns: DaemonTurnRegistry;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly runtimeSignal: AbortSignal;
    readonly timer: DaemonTimer;
    readonly resolveAgentCatalogEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>;
}

export function createDaemonCommandHandler({
    config,
    directories,
    audit,
    sessions,
    installations,
    nativeSessions,
    operations,
    publisher,
    activeTurns,
    diagnostics,
    socket,
    signal,
    runtimeSignal,
    timer,
    resolveAgentCatalogEnvironment,
}: DaemonCommandOptions): {
    readonly handle: (message: ServiceToDaemonMessage) => void;
    readonly settle: () => Promise<void>;
} {
    const handleSettingsDiscovery = createAgentSettingsDiscoveryHandler({
        config,
        directories,
        audit,
        sessions,
        diagnostics,
        socket,
        signal: signal,
        timer,
    });
    const handleCatalogRefresh = createAgentCatalogRefreshHandler({
        config,
        audit,
        diagnostics,
        socket,
        signal: signal,
        timer,
        resolveEnvironment: resolveAgentCatalogEnvironment,
    });
    const queueChanged = (sessionId: string): void =>
        publisher.publish(sessionId, { kind: "session.queue.changed", sessionId });
    const activeTurnSnapshot = (sessionId: string) =>
        activeTurns.snapshot((command) => command.sessionId === sessionId);
    const nativeRequestHandler = createNativeSessionRequestHandler({
        audit,
        diagnostics,
        nativeSessions,
        signal: signal,
        socket,
        timer,
    });

    return {
        handle: (message: ServiceToDaemonMessage): void => {
            const kind = message.kind;
            if (kind === SESSION_LIVE_HISTORY_LOAD_KIND) {
                const command = message;
                void executeSessionLiveHistoryLoad(
                    socket,
                    command,
                    config,
                    directories,
                    audit,
                    sessions,
                    activeTurnSnapshot,
                    signal,
                );
                return;
            }
            if (kind === SESSION_LIVE_HISTORY_PAGE_LOAD_KIND) {
                const command = message;
                void executeSessionLiveHistoryPageLoad(
                    socket,
                    command,
                    config,
                    directories,
                    audit,
                    sessions,
                    activeTurnSnapshot,
                    signal,
                );
                return;
            }
            if (kind === NATIVE_SESSION_CANCEL_KIND) {
                nativeRequestHandler.cancel(message);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
                handleSettingsDiscovery.handle(message);
                return;
            }
            if (kind === AGENT_CATALOG_REFRESH_KIND) {
                handleCatalogRefresh.handle(message);
                return;
            }
            if (kind === NATIVE_SESSION_REQUEST_KIND) {
                nativeRequestHandler.handle(message);
                return;
            }
            if (kind === FILE_READ_KIND) {
                const command = message;
                void streamLocalFile(
                    command,
                    (message) => send(socket, message),
                    signal,
                    sessions.findSessions([command.sessionId])[0]?.cwd ?? null,
                ).catch((error: unknown) => {
                    if (socket.readyState !== WebSocket.OPEN || signal.aborted) {
                        return;
                    }
                    send(socket, {
                        code: "file_unavailable",
                        kind: FILE_FAILED_KIND,
                        message: error instanceof Error ? error.message : "The local file is unavailable",
                        requestId: command.requestId,
                        sessionId: command.sessionId,
                    });
                });
                return;
            }
            if (kind === SESSION_CANCEL_KIND) {
                const cancellation = message;
                const turn = activeTurns.get(cancellation.commandId);
                if (turn === undefined || !turn.matches(cancellation)) {
                    settleAbandonedTurn(publisher, operations, audit, cancellation);
                    return;
                }
                const cancellationState = turn.requestCancellation();
                if (cancellationState === "already-requested") {
                    return;
                }
                audit.record({
                    commandId: cancellation.commandId,
                    event: "session_cancellation_requested",
                    sessionId: cancellation.sessionId,
                });
                if (cancellationState === "pending") {
                    return;
                }
                void sessions.cancelPrompt(cancellation.sessionId).catch((error) => {
                    console.error("Mobius daemon could not cancel the agent turn", error);
                });
                return;
            }
            if (kind === SESSION_PROMPT_DISPOSITION_KIND) {
                const disposition = message;
                const turn = activeTurns.get(disposition.commandId);
                if (turn === undefined || !turn.promoteQueuedPrompt(disposition)) {
                    reportOperationFailure(
                        socket,
                        disposition.commandId,
                        disposition.sessionId,
                        new Error("The queued prompt is unavailable"),
                    );
                }
                return;
            }
            if (kind === WORKSPACE_LIST_KIND) {
                const command = message;
                void executeWorkspaceList(socket, command, directories, audit, signal);
                return;
            }
            if (kind === SESSION_PREPARE_KIND) {
                const command = message;
                void executeSessionPrepare(publisher, socket, command, config, directories, audit, sessions, signal);
                return;
            }
            if (kind === SESSION_CONFIGURE_KIND) {
                const command = message;
                void executeSessionConfigure(publisher, socket, command, config, directories, audit, sessions, signal);
                return;
            }
            if (kind === SESSION_QUERY_KIND) {
                const command = message;
                void nativeSessions
                    .querySessions(command.sessionIds, signal)
                    .then((entries) => {
                        send(socket, {
                            entries,
                            kind: SESSION_QUERIED_KIND,
                            requestId: command.requestId,
                        });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, command.requestId, "", error);
                    });
                return;
            }
            if (kind === SESSION_PERMISSION_RESPOND_KIND) {
                const command = message;
                void sessions
                    .respondPermission(command)
                    .then(() => {
                        audit.record({
                            commandId: command.interactionId,
                            event: "session_permission_resolved",
                            sessionId: command.sessionId,
                        });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, command.interactionId, command.sessionId, error);
                    });
                return;
            }
            if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                const command = message;
                void sessions
                    .respondElicitation(command)
                    .then(() => {
                        audit.record({
                            commandId: command.interactionId,
                            event: "session_elicitation_resolved",
                            sessionId: command.sessionId,
                        });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, command.interactionId, command.sessionId, error);
                    });
                return;
            }
            if (kind === AGENT_INSTALL_REQUEST_KIND) {
                const command = message;
                void installations.request(command, runtimeSignal).catch((error: unknown) => {
                    console.error("Mobius Agent integration installation failed", error);
                });
                return;
            }
            if (kind === AGENT_INSTALL_CANCEL_KIND) {
                const command = message;
                void installations.cancel(command.requestId).catch((error: unknown) => {
                    reportOperationFailure(socket, command.requestId, "", error);
                });
                return;
            }
            if (kind !== SESSION_PROMPT_KIND) {
                throw new Error("Unsupported protocol message");
            }
            const command = message;
            const receipt = operations.claimExecution(
                command.commandId,
                command.sessionId,
                encodeSessionPromptCommand(command),
            );
            if (receipt.kind === "conflict") {
                const code = "command_identity_conflict";
                audit.record({
                    commandId: command.commandId,
                    details: { code },
                    event: "session_prompt_rejected",
                    sessionId: command.sessionId,
                });
                send(socket, {
                    code,
                    requestId: command.commandId,
                    kind: "session.operation.failed",
                    message: "This command identifier was already used for a different request.",
                    sessionId: command.sessionId,
                });
                return;
            }
            if (receipt.kind === "duplicate") {
                return;
            }

            const turn = activeTurns.start(command, receipt.attemptId);
            void executePrompt({
                operations,
                publisher,
                command,
                config,
                directories,
                audit,
                sessions,
                attemptId: receipt.attemptId,
                activateAttempt: turn.accept,
                acknowledgeQueued: () => {
                    queueChanged(command.sessionId);
                    send(socket, {
                        commandId: command.commandId,
                        kind: SESSION_QUEUED_KIND,
                        sessionId: command.sessionId,
                    });
                },
                waitForSessionAvailability: (waitSignal) => activeTurns.waitForAvailability(command, turn, waitSignal),
                timer,
                signal: turn.signal,
                recordLiveEvent: turn.recordEvent,
                cancellationRequested: turn.cancellationRequested,
            })
                .catch((error: unknown) => {
                    console.error("Mobius daemon turn failed", error);
                })
                .finally(() => {
                    activeTurns.finish(turn);
                    if (command.disposition === SessionPromptDisposition.Queue) {
                        queueChanged(command.sessionId);
                    }
                });
        },
        settle: async (): Promise<void> => {
            await Promise.all([
                nativeRequestHandler.settle(),
                handleSettingsDiscovery.settle(),
                handleCatalogRefresh.settle(),
            ]);
        },
    };
}
