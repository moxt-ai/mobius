import { randomUUID } from "node:crypto";
import { styleText } from "node:util";

import {
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    decodeServiceToDaemonMessage,
    decodeSessionLiveHistoryLoad,
    decodeSessionLiveHistoryPageLoad,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_TURN_FORK_KIND,
    type RecordedSessionEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { type MessageEvent, WebSocket } from "undici";

import { AcpSessionManager } from "./acp/session-manager.ts";
import { MemoryAcpSessionStore } from "./acp/session-store.ts";
import { supportedLocalAgentSpecifications } from "./agent-catalog/discover-local-agents.ts";
import { createAgentCatalogRefreshHandler } from "./agent-catalog/handle-agent-catalog-refresh.ts";
import { createAgentSettingsDiscoveryHandler } from "./agent-catalog/handle-agent-settings-discovery.ts";
import { AgentIntegrationDefinition } from "./agent-catalog/local-agent.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import { AgentInstallationManager } from "./agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "./agent-installation/fixed-installation-executor.ts";
import { streamLocalFile } from "./artifacts/local-file-streamer.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { DaemonDiagnosticLog } from "./daemon-diagnostic-log.ts";
import { AuditInstallationEvents, DaemonAcpObserver, DaemonInstallationObserver } from "./daemon-observers.ts";
import {
    executePrompt,
    executeSessionConfigure,
    executeSessionLiveHistoryLoad,
    executeSessionLiveHistoryPageLoad,
    executeSessionPrepare,
    executeWorkspaceList,
    reportOperationFailure,
    send,
    settleAbandonedTurn,
} from "./daemon-session-commands.ts";
import { ActiveDaemonTurn, ActiveTurnReconciliationError, reconcileActiveTurns } from "./daemon-turn-reconciliation.ts";
import { readCodexFullHistory } from "./native-sessions/codex-history.ts";
import { createNativeSessionRequestHandler } from "./native-sessions/handle-native-requests.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { connectRelay } from "./relay-connection/connect.ts";
import { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import { RelayConnectionLiveness } from "./relay-connection/liveness.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./relay-connection/runtime-revocation.ts";
import { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
import { type DaemonTimer, systemDaemonTimer } from "./relay-connection/timer.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;
const ACTIVE_TURN_RECONCILIATION_CLOSE_CODE = 4009;

function closeRelaySocket(socket: WebSocket, code: number, reason: string): void {
    try {
        socket.close(code, reason);
    } catch (error) {
        console.error("Mobius daemon could not close the Relay WebSocket", error);
        try {
            socket.close();
        } catch (fallbackError) {
            console.error("Mobius daemon could not release the Relay WebSocket", fallbackError);
        }
    }
}

function waitForRelayRetry(signal: AbortSignal, timer: DaemonTimer): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const retry = timer.schedule(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

        function finish(): void {
            retry.cancel();
            signal.removeEventListener("abort", finish);
            resolve();
        }

        signal.addEventListener("abort", finish, { once: true });
    });
}

async function publishAgentCatalogUntilAvailable(
    config: DaemonConfig,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
    timer: DaemonTimer,
): Promise<void> {
    try {
        await publishAgentCatalog(config, signal);
        return;
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        diagnostics.catalogFailed(error);
    }

    while (!signal.aborted) {
        await waitForRelayRetry(signal, timer);
        try {
            await publishAgentCatalog(config, signal);
            return;
        } catch {
            if (signal.aborted) {
                return;
            }
        }
    }
}

async function installDetectedAgentIntegrations(
    config: DaemonConfig,
    installations: AgentInstallationManager,
    signal: AbortSignal,
): Promise<void> {
    for (const agent of config.catalog.read().installableAgents) {
        if (!(agent instanceof AgentIntegrationDefinition)) {
            continue;
        }
        signal.throwIfAborted();
        await installations.request(
            {
                agentId: agent.id,
                kind: AGENT_INSTALL_REQUEST_KIND,
                requestId: `automatic-integration-${randomUUID()}`,
            },
            signal,
        );
    }
}

export interface RunDaemonOptions {
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    readonly resolveAgentCatalogEnvironment?: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>;
}

async function runRelayConnection(
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    installations: AgentInstallationManager,
    installationObserver: DaemonInstallationObserver,
    nativeSessions: NativeSessionService,
    operations: DaemonOperationState,
    publisher: DaemonSessionEventPublisher,
    activeTurns: Map<string, ActiveDaemonTurn>,
    connectionEpoch: number,
    diagnostics: RelayConnectionDiagnostics,
    onConnected: () => void,
    signal: AbortSignal,
    timer: DaemonTimer,
    resolveAgentCatalogEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>,
): Promise<void> {
    const relayUrl = new URL(config.relayUrl);
    relayUrl.searchParams.set("liveness", "1");
    const socket = await connectRelay(relayUrl, signal);
    const reconnectingTurns = [...activeTurns.values()];
    diagnostics.connectionOpened(connectionEpoch);
    const connectionController = new AbortController();
    const handleSettingsDiscovery = createAgentSettingsDiscoveryHandler({
        config,
        directories,
        audit,
        sessions,
        diagnostics,
        socket,
        signal: connectionController.signal,
        timer,
    });
    const handleCatalogRefresh = createAgentCatalogRefreshHandler({
        config,
        audit,
        diagnostics,
        socket,
        signal: connectionController.signal,
        timer,
        resolveEnvironment: resolveAgentCatalogEnvironment,
    });
    const nativeRequestHandler = createNativeSessionRequestHandler({
        audit,
        diagnostics,
        nativeSessions,
        signal: connectionController.signal,
        socket,
        timer,
    });
    installationObserver.connect(socket);
    onConnected();

    try {
        await new Promise<void>((resolve, reject) => {
            let finished = false;

            const cleanup = (): void => {
                connectionLiveness.close();
                signal.removeEventListener("abort", stop);
                socket.removeEventListener("close", handleClose);
                socket.removeEventListener("error", handleError);
                socket.removeEventListener("message", handleMessage);
                installationObserver.disconnect(socket);
                publisher.disconnect(socket);
                connectionController.abort();
            };

            const resolveConnection = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                resolve();
            };

            const rejectConnection = (failure: Error): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                reject(failure);
            };

            const stop = (): void => {
                diagnostics.connectionClosed(connectionEpoch, 1000, "Daemon stopped", "daemon_stop");
                closeRelaySocket(socket, 1000, "Daemon stopped");
                resolveConnection();
            };

            const failAndClose = (failure: Error, code: number, reason: string, source: string): void => {
                diagnostics.connectionFailed(connectionEpoch, failure, source);
                diagnostics.connectionClosed(connectionEpoch, code, reason, source);
                closeRelaySocket(socket, code, reason);
                rejectConnection(failure);
            };

            const waitForTurnCompletion = (turn: ActiveDaemonTurn, waitSignal: AbortSignal): Promise<void> => {
                waitSignal.throwIfAborted();
                return new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const finish = (
                        result: { readonly kind: "completed" } | { readonly kind: "failed"; readonly error: unknown },
                    ): void => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        waitSignal.removeEventListener("abort", onAbort);
                        if (result.kind === "completed") {
                            resolve();
                        } else {
                            reject(result.error);
                        }
                    };
                    const onAbort = (): void => finish({ error: waitSignal.reason, kind: "failed" });
                    waitSignal.addEventListener("abort", onAbort, { once: true });
                    void turn.completion.then(
                        () => finish({ kind: "completed" }),
                        (error: unknown) => finish({ error, kind: "failed" }),
                    );
                });
            };

            const waitForSessionAvailability = async (
                command: SessionPromptCommand,
                waitSignal: AbortSignal,
            ): Promise<"available" | "busy" | "queue-target-unavailable"> => {
                if (command.disposition === SessionPromptDisposition.Steer) {
                    return "available";
                }
                for (;;) {
                    const first = [...activeTurns.values()].find(
                        (turn) =>
                            turn.command.sessionId === command.sessionId &&
                            turn.command.disposition !== SessionPromptDisposition.Steer,
                    );
                    if (first === undefined || first.command.commandId === command.commandId) {
                        return command.disposition !== SessionPromptDisposition.Queue ||
                            operations.isTerminalExecution(command.targetCommandId, command.sessionId)
                            ? "available"
                            : "queue-target-unavailable";
                    }
                    if (command.disposition !== SessionPromptDisposition.Queue) {
                        return "busy";
                    }
                    if (first.command.commandId !== command.targetCommandId) {
                        return "queue-target-unavailable";
                    }
                    await waitForTurnCompletion(first, waitSignal);
                }
            };

            const connectionLiveness = new RelayConnectionLiveness(timer, {
                send: (message) => {
                    if (socket.readyState !== WebSocket.OPEN) {
                        return false;
                    }
                    try {
                        send(socket, message);
                        return true;
                    } catch (error) {
                        if (socket.readyState !== WebSocket.OPEN) {
                            return false;
                        }
                        throw error;
                    }
                },
                unresponsive: (heartbeatId, timeoutMilliseconds) => {
                    diagnostics.heartbeatTimedOut(connectionEpoch, heartbeatId, timeoutMilliseconds);
                    diagnostics.connectionClosed(
                        connectionEpoch,
                        4001,
                        "Relay liveness check timed out",
                        "heartbeat_timeout",
                    );
                    closeRelaySocket(socket, 4001, "Relay liveness check timed out");
                    resolveConnection();
                },
            });

            signal.addEventListener("abort", stop, { once: true });
            const handleClose = (event: CloseEvent): void => {
                diagnostics.connectionClosed(connectionEpoch, event.code, event.reason, "relay");
                if (isRuntimeRelayRevocation(event.code, event.reason)) {
                    rejectConnection(new RuntimeRelayRevokedError(event.code, event.reason));
                    return;
                }
                resolveConnection();
            };
            const handleError = (event: Event): void => {
                if (signal.aborted) {
                    resolveConnection();
                    return;
                }
                const cause = Reflect.get(event, "error");
                const failure = new Error("Relay WebSocket emitted an error", { cause: cause ?? event });
                diagnostics.connectionFailed(connectionEpoch, failure, "socket_error");
                diagnostics.connectionClosed(connectionEpoch, 1006, "WebSocket error", "socket_error");
                rejectConnection(failure);
            };
            const handleMessage = (event: MessageEvent<unknown>): void => {
                const encoded: unknown = event.data;
                if (typeof encoded !== "string") {
                    failAndClose(new Error("Relay sent a non-text message"), 4003, "Text message required", "protocol");
                    return;
                }

                try {
                    const message = decodeServiceToDaemonMessage(encoded);
                    const kind = message.kind;
                    if (kind === SESSION_LIVE_HISTORY_LOAD_KIND) {
                        const command = decodeSessionLiveHistoryLoad(encoded);
                        void executeSessionLiveHistoryLoad(
                            socket,
                            command,
                            config,
                            directories,
                            audit,
                            sessions,
                            connectionController.signal,
                        );
                        return;
                    }
                    if (kind === SESSION_LIVE_HISTORY_PAGE_LOAD_KIND) {
                        const command = decodeSessionLiveHistoryPageLoad(encoded);
                        void executeSessionLiveHistoryPageLoad(
                            socket,
                            command,
                            config,
                            directories,
                            audit,
                            sessions,
                            connectionController.signal,
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
                    if (kind === NATIVE_SESSION_REQUEST_KIND || kind === NATIVE_SESSION_TURN_FORK_KIND) {
                        nativeRequestHandler.handle(message);
                        return;
                    }
                    if (kind === RUNTIME_LIVENESS_READY_KIND) {
                        connectionLiveness.start();
                        return;
                    }
                    if (kind === RUNTIME_HEARTBEAT_ACK_KIND) {
                        connectionLiveness.acknowledge(message);
                        return;
                    }
                    if (kind === FILE_READ_KIND) {
                        const command = message;
                        void streamLocalFile(
                            command,
                            (message) => send(socket, message),
                            connectionController.signal,
                        ).catch((error: unknown) => {
                            if (socket.readyState !== WebSocket.OPEN || connectionController.signal.aborted) {
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
                    if (kind === WORKSPACE_LIST_KIND) {
                        const command = message;
                        void executeWorkspaceList(socket, command, directories, audit, connectionController.signal);
                        return;
                    }
                    if (kind === SESSION_PREPARE_KIND) {
                        const command = message;
                        void executeSessionPrepare(
                            publisher,
                            socket,
                            command,
                            config,
                            directories,
                            audit,
                            sessions,
                            connectionController.signal,
                        );
                        return;
                    }
                    if (kind === SESSION_CONFIGURE_KIND) {
                        const command = message;
                        void executeSessionConfigure(
                            publisher,
                            socket,
                            command,
                            config,
                            directories,
                            audit,
                            sessions,
                            connectionController.signal,
                        );
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
                        void installations.request(command, signal).catch((error: unknown) => {
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
                    if (activeTurns.has(command.commandId)) {
                        return;
                    }

                    const receipt = operations.claimExecution(command.commandId, command.sessionId, encoded);
                    if (receipt.kind === "duplicate") {
                        return;
                    }

                    const turn = new ActiveDaemonTurn(command, receipt.attemptId);
                    activeTurns.set(command.commandId, turn);
                    void executePrompt(
                        operations,
                        publisher,
                        command,
                        config,
                        directories,
                        audit,
                        sessions,
                        receipt.attemptId,
                        turn.accept,
                        (waitSignal) => waitForSessionAvailability(command, waitSignal),
                        timer,
                        turn.signal,
                        turn.recordText,
                        turn.cancellationRequested,
                    )
                        .catch((error: unknown) => {
                            console.error("Mobius daemon turn failed", error);
                        })
                        .finally(() => {
                            activeTurns.delete(command.commandId);
                            turn.finish();
                        });
                } catch (error) {
                    console.error("Mobius daemon rejected a message", error);
                    failAndClose(
                        new Error("Relay sent an invalid protocol message", { cause: error }),
                        4008,
                        "Invalid protocol message",
                        "protocol",
                    );
                }
            };
            socket.addEventListener("close", handleClose);
            socket.addEventListener("error", handleError);
            socket.addEventListener("message", handleMessage);
            void reconcileActiveTurns(config, reconnectingTurns, connectionController.signal).then(
                () => {
                    if (finished) {
                        return;
                    }
                    publisher.connect(socket);
                },
                (error: unknown) => {
                    if (finished) {
                        return;
                    }
                    console.error("Mobius daemon could not reconcile active Agent turns", error);
                    if (error instanceof ActiveTurnReconciliationError && error.terminal) {
                        // The Relay has already settled these Attempts, so this Runtime can never reconcile them.
                        // Abandoning the stale turns lets the connection recover instead of looping on code 4009.
                        diagnostics.reconciliationAbandoned(
                            connectionEpoch,
                            error.relayErrorCode,
                            reconnectingTurns.length,
                        );
                        console.error(
                            "Mobius daemon abandoned Agent turns the Relay already settled",
                            error.relayErrorCode,
                        );
                        for (const turn of reconnectingTurns) {
                            activeTurns.delete(turn.command.commandId);
                            turn.abortDaemon();
                        }
                        publisher.connect(socket);
                        return;
                    }
                    failAndClose(
                        new Error("Active Agent turn reconciliation failed", { cause: error }),
                        ACTIVE_TURN_RECONCILIATION_CLOSE_CODE,
                        "Active Agent turn reconciliation failed",
                        "reconciliation",
                    );
                },
            );

            if (signal.aborted) {
                stop();
            }
        });
    } finally {
        connectionController.abort();
        await Promise.all([
            nativeRequestHandler.settle(),
            handleSettingsDiscovery.settle(),
            handleCatalogRefresh.settle(),
        ]);
    }
}

export async function runDaemon(
    config: DaemonConfig,
    audit: AuditStore,
    signal: AbortSignal,
    timer: DaemonTimer = systemDaemonTimer,
    options: RunDaemonOptions = {},
): Promise<void> {
    const installationAudit = new AuditInstallationEvents(audit);
    const stateDirectory = config.localContext.stateDirectory;
    const specifications = supportedLocalAgentSpecifications();
    const installationExecutor = new FixedInstallationExecutor({
        defaultWorkspace: config.defaultWorkspace,
        audit: installationAudit,
        catalog: config.catalog,
        environment: config.localContext.environment,
        publishCatalog: async (installationSignal) => await publishAgentCatalog(config, installationSignal),
        stateDirectory,
    });
    const sessionStore = new MemoryAcpSessionStore();
    const operations = new DaemonOperationState();
    const publisher = new DaemonSessionEventPublisher();
    const activeTurns = new Map<string, ActiveDaemonTurn>();
    const recordSessionEvent = (sessionId: string, event: RecordedSessionEvent): void => {
        for (const turn of activeTurns.values()) {
            turn.recordInteraction(event);
        }
        publisher.publish(sessionId, event);
    };
    const sessions = new AcpSessionManager(
        new DaemonAcpObserver(recordSessionEvent),
        sessionStore,
        {
            read: async (options, nativeSessionId) =>
                options.agent.id === "codex"
                    ? (await readCodexFullHistory(options.agent, options.cwd, nativeSessionId, options.signal)).history
                    : null,
        },
        "native",
    );
    const directories = new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace);
    const installationObserver = new DaemonInstallationObserver();
    const diagnostics = new RelayConnectionDiagnostics(
        audit,
        config.channelId,
        config.relayUrl,
        new DaemonDiagnosticLog(stateDirectory),
    );
    const nativeSessions = new NativeSessionService(config, directories, sessions, audit, (request) => {
        const turn = [...activeTurns.values()].find(
            (candidate) =>
                candidate.command.sessionId === request.targetSessionId &&
                candidate.command.agentId === request.agentId &&
                candidate.command.directoryId === request.directoryId &&
                candidate.command.additionalDirectoryIds.length === request.additionalDirectoryIds.length &&
                candidate.command.additionalDirectoryIds.every(
                    (directoryId, index) => directoryId === request.additionalDirectoryIds[index],
                ),
        );
        return turn?.snapshot() ?? null;
    });
    const installations = new AgentInstallationManager(
        specifications,
        installationExecutor,
        installationObserver,
        installationAudit,
    );
    let connectionEpoch = 0;
    let automaticIntegrationProvisioningStarted = false;
    let automaticIntegrationProvisioning = Promise.resolve();
    let connectionAnnounced = false;
    let catalogPublished = false;
    let readinessAnnounced = false;
    const resolveAgentCatalogEnvironment =
        options.resolveAgentCatalogEnvironment ??
        (async (catalogSignal: AbortSignal): Promise<Readonly<NodeJS.ProcessEnv>> => {
            catalogSignal.throwIfAborted();
            return config.localContext.environment;
        });
    const startAutomaticIntegrationProvisioning = (): void => {
        if (!connectionAnnounced || !catalogPublished || automaticIntegrationProvisioningStarted) {
            return;
        }
        automaticIntegrationProvisioningStarted = true;
        automaticIntegrationProvisioning = installDetectedAgentIntegrations(config, installations, signal).catch(
            (error: unknown) => {
                if (!signal.aborted) {
                    console.error("Mobius daemon could not automatically install detected Agent integrations", error);
                }
            },
        );
    };
    const announceReadiness = (): void => {
        if (!connectionAnnounced || !catalogPublished) {
            return;
        }
        options.onConnectionStatus?.("online");
        if (readinessAnnounced) {
            return;
        }
        readinessAnnounced = true;
        process.stdout.write("Mobius daemon is ready for Agent requests.\n");
    };
    const announceConnection = (): void => {
        if (connectionAnnounced) {
            return;
        }
        connectionAnnounced = true;
        process.stdout.write("Mobius daemon connected to the relay.\n\n");
        if (config.reconnectTarget !== null) {
            const reconnectCommand = `mobius start ${config.reconnectTarget.commandArgument}`;
            process.stdout.write(
                `${styleText(["bold", "yellow"], `Reconnect this local connection later:\n  ${reconnectCommand}`)}\n\n`,
            );
        }
        announceReadiness();
        startAutomaticIntegrationProvisioning();
    };
    const catalogPublication = publishAgentCatalogUntilAvailable(config, diagnostics, signal, timer);
    void catalogPublication.then(() => {
        if (signal.aborted) {
            return;
        }
        catalogPublished = true;
        announceReadiness();
        startAutomaticIntegrationProvisioning();
    });

    try {
        while (!signal.aborted) {
            connectionEpoch += 1;
            try {
                await runRelayConnection(
                    config,
                    directories,
                    audit,
                    sessions,
                    installations,
                    installationObserver,
                    nativeSessions,
                    operations,
                    publisher,
                    activeTurns,
                    connectionEpoch,
                    diagnostics,
                    () => {
                        if (catalogPublished) {
                            options.onConnectionStatus?.("online");
                        }
                        announceConnection();
                    },
                    signal,
                    timer,
                    resolveAgentCatalogEnvironment,
                );
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                if (error instanceof RuntimeRelayRevokedError) {
                    throw error;
                }
                diagnostics.connectionFailed(connectionEpoch, error, "connection");
            }

            options.onConnectionStatus?.("reconnecting");
            await waitForRelayRetry(signal, timer);
        }
    } finally {
        const turns = [...activeTurns.values()];
        for (const turn of turns) {
            turn.abortDaemon();
        }
        await Promise.all(turns.map((turn) => turn.completion));
        try {
            await catalogPublication;
        } finally {
            try {
                await automaticIntegrationProvisioning;
            } finally {
                try {
                    await installations.close();
                } finally {
                    try {
                        await sessions.close();
                    } finally {
                        try {
                            publisher.close();
                        } finally {
                            operations.close();
                        }
                    }
                }
            }
        }
    }
}
