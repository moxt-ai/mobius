import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-protocol";
import {
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    encodeSessionPromptCommand,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_QUEUED_KIND,
    SESSION_RESTORE_KIND,
    SessionPromptDisposition,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import packageMetadata from "../package.json" with { type: "json" };
import type { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import { createAgentSettingsDiscoveryHandler } from "./agent-catalog/handle-agent-settings-discovery.ts";
import type { AgentInstallationManager } from "./agent-installation/agent-installation-manager.ts";
import { streamLocalFile } from "./artifacts/local-file-streamer.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { reportOperationFailure, send, settleAbandonedTurn } from "./daemon-command-results.ts";
import {
    executeSessionLiveHistoryV2PageLoad,
    executeSessionPreviewHistoryPageLoad,
} from "./daemon-history-commands.ts";
import { executePrompt } from "./daemon-prompt-executor.ts";
import {
    executeSessionConfigure,
    executeSessionPrepare,
    executeSessionRestore,
    executeWorkspaceList,
} from "./daemon-session-commands.ts";
import type { DaemonTurnRegistry } from "./daemon-turn-registry.ts";
import type { ExternalContentStore } from "./external-content/local-external-content-store.ts";
import { createNativeSessionRequestHandler } from "./native-sessions/handle-native-requests.ts";
import type { NativeSessionService } from "./native-sessions/service.ts";
import type { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonTimer } from "./relay-connection/timer.ts";
import type { DaemonSessionEventProjectionV2 } from "./session-event-projection-v2.ts";
export interface DaemonCommandOptions {
    readonly config: DaemonConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly installations: AgentInstallationManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: DaemonOperationState;
    readonly eventProjectionV2: DaemonSessionEventProjectionV2;
    readonly externalContent: ExternalContentStore;
    readonly activeTurns: DaemonTurnRegistry;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly runtimeSignal: AbortSignal;
    readonly timer: DaemonTimer;
}

export function createDaemonCommandHandler({
    config,
    directories,
    sessions,
    installations,
    nativeSessions,
    operations,
    eventProjectionV2,
    externalContent,
    activeTurns,
    diagnostics,
    socket,
    signal,
    runtimeSignal,
    timer,
}: DaemonCommandOptions): {
    readonly handle: (message: ServiceToDaemonMessage) => void;
    readonly settle: () => Promise<void>;
} {
    const handleSettingsDiscovery = createAgentSettingsDiscoveryHandler({
        config,
        directories,
        sessions,
        diagnostics,
        socket,
        signal: signal,
        timer,
    });
    const queueChanged = (sessionId: string): void => {
        void eventProjectionV2.queueChanged(sessionId).catch((error: unknown) => {
            console.error("Could not record queue change", error);
        });
    };
    const nativeRequestHandler = createNativeSessionRequestHandler({
        diagnostics,
        nativeSessions,
        signal: signal,
        socket,
        timer,
    });

    return {
        handle: (message: ServiceToDaemonMessage): void => {
            const kind = message.kind;
            if (kind === "runtime.diagnostics.read") {
                // This fixed capability cannot select files, paths or arbitrary local state.
                try {
                    send(socket, {
                        kind: "runtime.diagnostics.result",
                        requestId: message.requestId,
                        version: packageMetadata.version,
                        ...diagnostics.snapshot(),
                    });
                } catch {
                    send(socket, {
                        kind: "session.operation.failed",
                        requestId: message.requestId,
                        sessionId: "runtime",
                        code: "diagnostics_unavailable",
                        message: "Local diagnostics are unavailable.",
                    });
                }
                return;
            }
            if (kind === RUNTIME_PING_KIND) {
                send(socket, { kind: RUNTIME_PONG_KIND, requestId: message.requestId });
                return;
            }
            if (kind === SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND) {
                void executeSessionLiveHistoryV2PageLoad(
                    socket,
                    message,
                    config,
                    directories,
                    diagnostics,
                    sessions,
                    nativeSessions,
                    eventProjectionV2,
                    signal,
                );
                return;
            }
            if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND) {
                void executeSessionPreviewHistoryPageLoad(
                    socket,
                    message,
                    config,
                    directories,
                    diagnostics,
                    sessions,
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
                    externalContent,
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
                    void settleAbandonedTurn(eventProjectionV2, operations, cancellation).catch((error: unknown) => {
                        console.error("Could not settle abandoned turn", error);
                    });
                    return;
                }
                const cancellationState = turn.requestCancellation();
                if (cancellationState === "already-requested") {
                    return;
                }
                if (cancellationState === "pending") {
                    return;
                }
                void sessions.cancelPrompt(cancellation.sessionId).catch((error) => {
                    console.error("Mobius daemon could not cancel the agent turn", error);
                });
                return;
            }
            if (kind === SESSION_CLOSE_KIND) {
                const command = message;
                void sessions
                    .closeSession(command.sessionId, signal)
                    .then(() => {
                        send(socket, {
                            kind: SESSION_CLOSED_KIND,
                            requestId: command.requestId,
                            sessionId: command.sessionId,
                        });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, command.requestId, command.sessionId, error);
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
                void executeWorkspaceList(socket, command, directories, signal);
                return;
            }
            if (kind === SESSION_PREPARE_KIND) {
                const command = message;
                void executeSessionPrepare(socket, command, config, directories, sessions, diagnostics, signal);
                return;
            }
            if (kind === SESSION_CONFIGURE_KIND) {
                const command = message;
                void executeSessionConfigure(socket, command, config, directories, sessions, signal);
                return;
            }
            if (kind === SESSION_LIST_KIND) {
                const command = message;
                void nativeSessions
                    .listSessions(command.limit, signal)
                    .then((entries) => {
                        send(socket, {
                            entries,
                            kind: SESSION_LISTED_KIND,
                            requestId: command.requestId,
                        });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, command.requestId, "", error);
                    });
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
            if (kind === SESSION_RESTORE_KIND) {
                const command = message;
                void executeSessionRestore(
                    socket,
                    command,
                    config,
                    directories,
                    sessions,
                    nativeSessions,
                    diagnostics,
                    signal,
                );
                return;
            }
            if (kind === SESSION_PERMISSION_RESPOND_KIND) {
                const command = message;
                void sessions.respondPermission(command).catch((error: unknown) => {
                    reportOperationFailure(socket, command.interactionId, command.sessionId, error);
                });
                return;
            }
            if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                const command = message;
                void sessions.respondElicitation(command).catch((error: unknown) => {
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
            eventProjectionV2.requested(command);
            void executePrompt({
                operations,
                eventProjectionV2,
                command,
                config,
                directories,
                sessions,
                attemptId: receipt.attemptId,
                activateAttempt: turn.activate,
                waitForSessionAvailability: (waitSignal) =>
                    activeTurns.admitAndWait(turn, waitSignal, () => {
                        queueChanged(command.sessionId);
                        send(socket, {
                            commandId: command.commandId,
                            kind: SESSION_QUEUED_KIND,
                            sessionId: command.sessionId,
                        });
                    }),
                signal: turn.signal,
                recordTurnEvent: turn.recordEvent,
                recordSteeringPrompt: () => activeTurns.recordSteeringPrompt(command),
                cancellationRequested: turn.cancellationRequested,
            })
                .catch((error: unknown) => {
                    console.error("Mobius daemon turn failed", error);
                })
                .finally(() => {
                    activeTurns.finish(turn);
                    eventProjectionV2.publishTerminal(command.sessionId, command.commandId);
                    if (command.disposition === SessionPromptDisposition.Queue) {
                        queueChanged(command.sessionId);
                    }
                });
        },
        settle: async (): Promise<void> => {
            await Promise.all([nativeRequestHandler.settle(), handleSettingsDiscovery.settle()]);
        },
    };
}
