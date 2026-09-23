import { randomUUID } from "node:crypto";
import { styleText } from "node:util";

import {
    AGENT_CATALOG_REFRESH_FAILED_KIND,
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentCatalogRefreshCommand,
    decodeServiceToDaemonMessage,
    decodeSessionLiveHistoryLoad,
    decodeSessionLiveHistoryPageLoad,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_TURN_FORK_KIND,
    type RecordedSessionEvent,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type RuntimeDelivery,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { type MessageEvent, WebSocket } from "undici";

import { AcpConfigurationValueUnavailableError, AcpExecutionError, AcpSessionManager } from "./acp/session-manager.ts";
import { MemoryAcpSessionStore } from "./acp/session-store.ts";
import { discoverAgentSettings } from "./agent-catalog/discover-agent-settings.ts";
import {
    discoverLocalAgentInventory,
    supportedLocalAgentSpecifications,
} from "./agent-catalog/discover-local-agents.ts";
import { type AcpAgentDefinition, AgentIntegrationDefinition } from "./agent-catalog/local-agent.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import { AgentInstallationManager } from "./agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "./agent-installation/fixed-installation-executor.ts";
import { streamLocalFile } from "./artifacts/local-file-streamer.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import { type DaemonConfig, DaemonLocalContext, withDaemonEnvironment } from "./config.ts";
import { DaemonDiagnosticLog } from "./daemon-diagnostic-log.ts";
import { AuditInstallationEvents, DaemonAcpObserver, DaemonInstallationObserver } from "./daemon-observers.ts";
import {
    agentSettingsFailureDetails,
    type DaemonTurnCommand,
    executePrompt,
    executeSessionConfigure,
    executeSessionLiveHistoryLoad,
    executeSessionLiveHistoryPageLoad,
    executeSessionPrepare,
    executeWorkspaceList,
    operationErrorCode,
    operationErrorMessage,
    reportFailure,
    reportOperationFailure,
    send,
    settleAbandonedTurn,
} from "./daemon-session-commands.ts";
import { ActiveDaemonTurn, ActiveTurnReconciliationError, reconcileActiveTurns } from "./daemon-turn-reconciliation.ts";
import { readCodexFullHistory } from "./native-sessions/codex-history.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { revalidateExecutable } from "./process/executable.ts";
import { connectRelay } from "./relay-connection/connect.ts";
import { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import { RelayConnectionLiveness } from "./relay-connection/liveness.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./relay-connection/runtime-revocation.ts";
import { RuntimeDeliveryInboxCapacityError, SessionEventOutbox } from "./relay-connection/session-event-outbox.ts";
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

// A refresh observes the machine through executable discovery, which depends on ambient state such
// as PATH and the managed state directory. An Agent that was verified a moment ago is therefore not
// necessarily uninstalled just because one discovery attempt failed to re-verify it. Keep the last
// verified definition while the exact executable it was verified against still exists unchanged on
// disk, so a transient probe failure cannot silently drop a working Agent. A genuine removal, or a
// replaced executable, stops satisfying that check and is still reflected in the catalog.
async function retainStillInstalledAgents(
    previous: readonly AcpAgentDefinition[],
    refreshed: readonly AcpAgentDefinition[],
    signal: AbortSignal,
): Promise<readonly AcpAgentDefinition[]> {
    const refreshedIdentifiers = new Set(refreshed.map((agent) => agent.id));
    const retained: AcpAgentDefinition[] = [];
    for (const agent of previous) {
        if (refreshedIdentifiers.has(agent.id)) {
            continue;
        }
        signal.throwIfAborted();
        if (await revalidateExecutable(agent.agentIdentity)) {
            retained.push(agent);
        }
    }
    return Object.freeze([...refreshed, ...retained]);
}

async function refreshAgentCatalog(
    config: DaemonConfig,
    resolveEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const shellEnvironment = await resolveEnvironment(signal);
    const environment = new DaemonLocalContext(config.localContext.stateDirectory, shellEnvironment).environment;
    signal.throwIfAborted();
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: config.defaultWorkspace,
        environment,
        signal,
    });
    const previousCatalog = config.catalog.read();
    const refreshedAgents = inventory.readyAgents().map((agent) => withDaemonEnvironment(agent, environment));
    const agents = await retainStillInstalledAgents(previousCatalog.agents, refreshedAgents, signal);
    const verifiedIdentifiers = new Set(agents.map((agent) => agent.id));
    config.catalog.transition(
        agents,
        inventory.installable.filter((agent) => !verifiedIdentifiers.has(agent.id)),
    );
    try {
        await publishAgentCatalog(config, signal);
    } catch (error) {
        config.catalog.transition(previousCatalog.agents, previousCatalog.installableAgents);
        throw error;
    }
}

async function runRelayConnection(
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    installations: AgentInstallationManager,
    installationObserver: DaemonInstallationObserver,
    nativeSessions: NativeSessionService,
    outbox: SessionEventOutbox,
    publisher: DaemonSessionEventPublisher,
    activeTurns: Map<string, ActiveDaemonTurn>,
    activeAttemptIds: Map<string, string>,
    connectionEpoch: number,
    diagnostics: RelayConnectionDiagnostics,
    onConnected: () => void,
    signal: AbortSignal,
    timer: DaemonTimer,
    resolveAgentCatalogEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>,
): Promise<void> {
    const relayUrl = new URL(config.relayUrl);
    relayUrl.searchParams.set("deliveryReceipts", "1");
    relayUrl.searchParams.set("liveness", "1");
    const socket = await connectRelay(relayUrl, signal);
    const reconnectingTurns = [...activeTurns.values()];
    diagnostics.connectionOpened(connectionEpoch);
    const connectionController = new AbortController();
    const nativeRequests = new Map<
        string,
        {
            readonly agentId: string;
            readonly sessionId: string;
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const agentSettingsDiscoveries = new Map<
        string,
        {
            readonly agentId: string;
            readonly model: string | undefined;
            readonly requestIds: Set<string>;
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const agentCatalogRefreshes = new Map<
        string,
        {
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
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

            const processingDeliveryIds = new Set<string>();

            const processDeliveredPrompt = async (
                delivery: RuntimeDelivery,
                command: DaemonTurnCommand,
                trackActiveAttempt: boolean,
                execute: (attemptId: string, activateAttempt: () => void, signal: AbortSignal) => Promise<void>,
            ): Promise<void> => {
                if (command.sessionId !== delivery.sessionId) {
                    throw new Error("Runtime delivery Session identity does not match its payload");
                }
                const active = activeTurns.get(command.commandId);
                if (active !== undefined) {
                    await active.completion;
                    return;
                }
                const receipt = outbox.claimExecution(command.commandId, command.sessionId, delivery.payload);
                if (receipt.kind === "duplicate") {
                    if (receipt.state === "running") {
                        reportFailure(
                            publisher,
                            command,
                            "agent_execution_interrupted",
                            "The local Agent execution was interrupted before it completed",
                            receipt.attemptId,
                        );
                        outbox.transitionExecution(command.commandId, "failed");
                        return;
                    }
                    if (receipt.state !== "dispatching") {
                        return;
                    }
                }

                const turn = new ActiveDaemonTurn(command, receipt.attemptId);
                activeTurns.set(command.commandId, turn);
                const activateAttempt = (): void => {
                    if (trackActiveAttempt) {
                        activeAttemptIds.set(command.sessionId, receipt.attemptId);
                    }
                };
                try {
                    await execute(receipt.attemptId, activateAttempt, turn.signal);
                } finally {
                    activeTurns.delete(command.commandId);
                    if (activeAttemptIds.get(command.sessionId) === receipt.attemptId) {
                        activeAttemptIds.delete(command.sessionId);
                    }
                    turn.finish();
                }
            };

            const processDeliveredPayload = async (delivery: RuntimeDelivery): Promise<void> => {
                const message = decodeServiceToDaemonMessage(delivery.payload);
                const kind = message.kind;
                if (kind === SESSION_CANCEL_KIND) {
                    const cancellation = message;
                    if (cancellation.sessionId !== delivery.sessionId) {
                        throw new Error("Runtime delivery Session identity does not match its payload");
                    }
                    const turn = activeTurns.get(cancellation.commandId);
                    if (turn === undefined || !turn.matches(cancellation)) {
                        settleAbandonedTurn(publisher, outbox, audit, cancellation);
                        return;
                    }
                    if (!turn.requestCancellation()) {
                        return;
                    }
                    audit.record({
                        commandId: cancellation.commandId,
                        event: "session_cancellation_requested",
                        sessionId: cancellation.sessionId,
                    });
                    await sessions.cancelPrompt(cancellation.sessionId);
                    return;
                }
                if (kind === SESSION_CONFIGURE_KIND) {
                    const command = message;
                    if (command.sessionId !== delivery.sessionId) {
                        throw new Error("Runtime delivery Session identity does not match its payload");
                    }
                    await executeSessionConfigure(
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
                    if (command.sessionId !== delivery.sessionId) {
                        throw new Error("Runtime delivery Session identity does not match its payload");
                    }
                    try {
                        await sessions.respondPermission(command);
                        audit.record({
                            commandId: command.interactionId,
                            event: "session_permission_resolved",
                            sessionId: command.sessionId,
                        });
                    } catch (error) {
                        reportOperationFailure(socket, command.interactionId, command.sessionId, error);
                    }
                    return;
                }
                if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                    const command = message;
                    if (command.sessionId !== delivery.sessionId) {
                        throw new Error("Runtime delivery Session identity does not match its payload");
                    }
                    try {
                        await sessions.respondElicitation(command);
                        audit.record({
                            commandId: command.interactionId,
                            event: "session_elicitation_resolved",
                            sessionId: command.sessionId,
                        });
                    } catch (error) {
                        reportOperationFailure(socket, command.interactionId, command.sessionId, error);
                    }
                    return;
                }
                if (kind === SESSION_PROMPT_KIND) {
                    const command = message;
                    await processDeliveredPrompt(
                        delivery,
                        command,
                        command.disposition !== SessionPromptDisposition.Steer,
                        (attemptId, activateAttempt, executionSignal) =>
                            executePrompt(
                                outbox,
                                publisher,
                                command,
                                config,
                                directories,
                                audit,
                                sessions,
                                attemptId,
                                activateAttempt,
                                timer,
                                executionSignal,
                            ),
                    );
                    return;
                }
                throw new Error("Runtime delivery contains an unsupported protocol message");
            };

            const processRuntimeDelivery = (delivery: RuntimeDelivery, state: string): void => {
                if (state === "processed" || processingDeliveryIds.has(delivery.deliveryId)) {
                    return;
                }
                processingDeliveryIds.add(delivery.deliveryId);
                void processDeliveredPayload(delivery)
                    .then(() => {
                        outbox.markRuntimeDeliveryProcessed(delivery.deliveryId, delivery.sessionId);
                    })
                    .catch((error: unknown) => {
                        if (connectionController.signal.aborted) {
                            return;
                        }
                        console.error("Mobius daemon could not process a in-memory Runtime delivery", error);
                        failAndClose(
                            new Error("Runtime delivery processing failed", { cause: error }),
                            4008,
                            "Invalid Runtime delivery",
                            "delivery",
                        );
                    })
                    .finally(() => processingDeliveryIds.delete(delivery.deliveryId));
            };

            const receiveRuntimeDelivery = (delivery: RuntimeDelivery): void => {
                const payload = decodeServiceToDaemonMessage(delivery.payload);
                const payloadKind = payload.kind;
                let payloadSessionId = "";
                if (payloadKind === SESSION_CANCEL_KIND) {
                    payloadSessionId = payload.sessionId;
                } else if (payloadKind === SESSION_CONFIGURE_KIND) {
                    payloadSessionId = payload.sessionId;
                } else if (payloadKind === SESSION_PERMISSION_RESPOND_KIND) {
                    payloadSessionId = payload.sessionId;
                } else if (payloadKind === SESSION_ELICITATION_RESPOND_KIND) {
                    payloadSessionId = payload.sessionId;
                } else if (payloadKind === SESSION_PROMPT_KIND) {
                    payloadSessionId = payload.sessionId;
                } else {
                    throw new Error("Runtime delivery contains an unsupported protocol message");
                }
                if (payloadSessionId !== delivery.sessionId) {
                    throw new Error("Runtime delivery Session identity does not match its payload");
                }
                const stored = outbox.claimRuntimeDelivery(delivery);
                send(socket, {
                    deliveryId: delivery.deliveryId,
                    kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                    sessionId: delivery.sessionId,
                });
                processRuntimeDelivery(delivery, stored.state);
            };

            const resumeRuntimeDeliveries = (): void => {
                for (const stored of outbox.runtimeDeliveries()) {
                    const delivery: RuntimeDelivery = {
                        deliveryId: stored.deliveryId,
                        kind: RUNTIME_DELIVERY_KIND,
                        payload: stored.payload,
                        sessionId: stored.sessionId,
                    };
                    if (stored.state !== "relay_committed") {
                        send(socket, {
                            deliveryId: stored.deliveryId,
                            kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                            sessionId: stored.sessionId,
                        });
                    }
                    processRuntimeDelivery(delivery, stored.state);
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
                    if (kind === RUNTIME_DELIVERY_COMMITTED_KIND) {
                        const committed = message;
                        if (!outbox.markRuntimeDeliveryCommitted(committed.deliveryId, committed.sessionId)) {
                            console.warn("Mobius daemon ignored confirmation for an unknown Runtime delivery");
                        }
                        return;
                    }
                    if (kind === RUNTIME_DELIVERY_KIND) {
                        receiveRuntimeDelivery(message);
                        return;
                    }
                    if (kind === SESSION_EVENT_ACK_KIND) {
                        publisher.acknowledge(message);
                        return;
                    }
                    if (kind === SESSION_EVENT_DEFERRED_KIND) {
                        publisher.defer(message);
                        return;
                    }
                    if (kind === SESSION_EVENT_REJECTED_KIND) {
                        const rejection = message;
                        if (publisher.quarantine(rejection)) {
                            audit.record({
                                commandId: rejection.eventId,
                                details: { code: rejection.code },
                                event: "session_event_rejected",
                                sessionId: rejection.sessionId,
                            });
                        } else {
                            console.warn("Mobius daemon ignored a rejection for an unknown session event");
                        }
                        return;
                    }
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
                        const command = message;
                        const pending = nativeRequests.get(command.requestId);
                        if (pending?.sessionId === command.sessionId) {
                            pending.controller.abort(
                                new AcpExecutionError(
                                    "Native session operation cancelled",
                                    {},
                                    "native_session_cancelled",
                                ),
                            );
                        }
                        return;
                    }
                    if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
                        const command = message;
                        const existing = [...agentSettingsDiscoveries.values()].find(
                            (request) => request.agentId === command.agentId && !request.controller.signal.aborted,
                        );
                        if (
                            [...agentSettingsDiscoveries.values()].some((request) =>
                                request.requestIds.has(command.requestId),
                            )
                        ) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(socket, {
                                    code: "agent_settings_discovery_busy",
                                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                    message: "This settings discovery request is already running",
                                    requestId: command.requestId,
                                });
                            }
                            return;
                        }
                        if (
                            existing !== undefined &&
                            existing.model === command.model &&
                            existing.requestIds.size < 16
                        ) {
                            existing.requestIds.add(command.requestId);
                            return;
                        }
                        if (existing !== undefined) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(socket, {
                                    code: "agent_settings_discovery_busy",
                                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                    message: "Another settings discovery is already running for this Agent",
                                    requestId: command.requestId,
                                });
                            }
                            return;
                        }
                        if (agentSettingsDiscoveries.size >= 4) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(socket, {
                                    code: "agent_settings_discovery_busy",
                                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                    message: "Too many Agent settings discoveries are running",
                                    requestId: command.requestId,
                                });
                            }
                            return;
                        }
                        const controller = new AbortController();
                        const requestIds = new Set([command.requestId]);
                        const operationSignal = AbortSignal.any([connectionController.signal, controller.signal]);
                        const timeout = timer.schedule(
                            () =>
                                controller.abort(
                                    new AcpExecutionError(
                                        "Agent settings discovery timed out",
                                        {},
                                        "agent_settings_discovery_timeout",
                                    ),
                                ),
                            90_000,
                        );
                        const completion = (async (): Promise<void> => {
                            try {
                                const result = await discoverAgentSettings(
                                    command,
                                    config,
                                    directories,
                                    sessions,
                                    operationSignal,
                                );
                                for (const diagnostic of result.unsupportedModels) {
                                    const details = agentSettingsFailureDetails(command.agentId, diagnostic);
                                    audit.record({
                                        commandId: command.requestId,
                                        details,
                                        event: "agent_settings_model_unsupported",
                                        sessionId: `agent-settings:${command.agentId}`,
                                    });
                                    diagnostics.daemonDiagnostic(
                                        "agent_settings_model_unsupported",
                                        command.requestId,
                                        details,
                                    );
                                    process.stderr.write(
                                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_model_unsupported", requestId: command.requestId, ...details })}\n`,
                                    );
                                }
                                for (const requestId of requestIds) {
                                    audit.record({
                                        commandId: requestId,
                                        details: {
                                            agentId: command.agentId,
                                            unsupportedModelCount: result.unsupportedModels.length.toString(),
                                        },
                                        event: "agent_settings_discovered",
                                        sessionId: `agent-settings:${command.agentId}`,
                                    });
                                    if (socket.readyState === WebSocket.OPEN) {
                                        send(socket, { ...result.event, requestId });
                                    }
                                }
                            } catch (error) {
                                const failure: unknown = operationSignal.aborted
                                    ? (controller.signal.reason ??
                                      new AcpExecutionError(
                                          "Agent settings discovery cancelled",
                                          {},
                                          "agent_settings_discovery_cancelled",
                                      ))
                                    : error;
                                const details = agentSettingsFailureDetails(command.agentId, failure);
                                for (const requestId of requestIds) {
                                    audit.record({
                                        commandId: requestId,
                                        details,
                                        event: "agent_settings_discovery_failed",
                                        sessionId: `agent-settings:${command.agentId}`,
                                    });
                                }
                                diagnostics.daemonDiagnostic(
                                    "agent_settings_discovery_failed",
                                    command.requestId,
                                    details,
                                    failure,
                                );
                                if (failure instanceof AcpConfigurationValueUnavailableError) {
                                    process.stderr.write(
                                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_discovery_failed", requestId: command.requestId, ...details })}\n`,
                                    );
                                }
                                if (socket.readyState === WebSocket.OPEN) {
                                    for (const requestId of requestIds) {
                                        send(socket, {
                                            code: operationErrorCode(failure),
                                            kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                            message: operationErrorMessage(failure),
                                            requestId,
                                        });
                                    }
                                }
                            } finally {
                                timeout.cancel();
                                agentSettingsDiscoveries.delete(command.requestId);
                            }
                        })();
                        agentSettingsDiscoveries.set(command.requestId, {
                            agentId: command.agentId,
                            model: command.model,
                            requestIds,
                            completion,
                            controller,
                        });
                        return;
                    }
                    if (kind === AGENT_CATALOG_REFRESH_KIND) {
                        const command: AgentCatalogRefreshCommand = message;
                        if (agentCatalogRefreshes.has(command.requestId) || agentCatalogRefreshes.size > 0) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(socket, {
                                    code: "agent_catalog_refresh_busy",
                                    kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                                    message: "Another local Agent catalog refresh is already running",
                                    requestId: command.requestId,
                                });
                            }
                            return;
                        }
                        const controller = new AbortController();
                        const operationSignal = AbortSignal.any([connectionController.signal, controller.signal]);
                        const timeout = timer.schedule(
                            () =>
                                controller.abort(
                                    new AcpExecutionError(
                                        "The local Agent catalog refresh timed out",
                                        {},
                                        "agent_catalog_refresh_timeout",
                                    ),
                                ),
                            90_000,
                        );
                        const completion = (async (): Promise<void> => {
                            try {
                                await refreshAgentCatalog(config, resolveAgentCatalogEnvironment, operationSignal);
                                audit.record({
                                    commandId: command.requestId,
                                    event: "agent_catalog_refreshed",
                                    sessionId: "agent-catalog",
                                });
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, {
                                        kind: AGENT_CATALOG_REFRESHED_KIND,
                                        requestId: command.requestId,
                                    });
                                }
                            } catch (error) {
                                const failure: unknown = operationSignal.aborted
                                    ? (controller.signal.reason ??
                                      new AcpExecutionError(
                                          "The local Agent catalog refresh was cancelled",
                                          {},
                                          "agent_catalog_refresh_cancelled",
                                      ))
                                    : error;
                                audit.record({
                                    commandId: command.requestId,
                                    details: { code: operationErrorCode(failure) },
                                    event: "agent_catalog_refresh_failed",
                                    sessionId: "agent-catalog",
                                });
                                diagnostics.daemonDiagnostic(
                                    "agent_catalog_refresh_failed",
                                    command.requestId,
                                    { code: operationErrorCode(failure) },
                                    failure,
                                );
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, {
                                        code: operationErrorCode(failure),
                                        kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                                        message: operationErrorMessage(failure),
                                        requestId: command.requestId,
                                    });
                                }
                            } finally {
                                timeout.cancel();
                                agentCatalogRefreshes.delete(command.requestId);
                            }
                        })();
                        agentCatalogRefreshes.set(command.requestId, { completion, controller });
                        return;
                    }
                    if (kind === NATIVE_SESSION_REQUEST_KIND) {
                        const command = message;
                        const previous = [...nativeRequests.values()].filter(
                            (request) => request.agentId === command.agentId,
                        );
                        if (
                            nativeRequests.has(command.requestId) ||
                            nativeRequests.size >= 4 ||
                            (command.action !== "linked-history" &&
                                previous.some((request) => !request.controller.signal.aborted))
                        ) {
                            reportOperationFailure(
                                socket,
                                command.requestId,
                                command.sessionId,
                                new AcpExecutionError(
                                    "Another native session operation is running",
                                    {},
                                    "native_session_busy",
                                ),
                            );
                            return;
                        }
                        const controller = new AbortController();
                        const operationSignal = AbortSignal.any([connectionController.signal, controller.signal]);
                        const timeout = timer.schedule(
                            () =>
                                controller.abort(
                                    new AcpExecutionError(
                                        "Native session operation timed out",
                                        {},
                                        "native_session_timeout",
                                    ),
                                ),
                            90_000,
                        );
                        const completion = (async (): Promise<void> => {
                            try {
                                operationSignal.throwIfAborted();
                                if (previous.length > 0) {
                                    await new Promise<void>((resolve, reject) => {
                                        const cancel = (): void => reject(operationSignal.reason);
                                        operationSignal.addEventListener("abort", cancel, {
                                            once: true,
                                        });
                                        void Promise.all(previous.map((request) => request.completion)).then(
                                            () => {
                                                operationSignal.removeEventListener("abort", cancel);
                                                resolve();
                                            },
                                            (error: unknown) => {
                                                operationSignal.removeEventListener("abort", cancel);
                                                reject(error);
                                            },
                                        );
                                    });
                                }
                                operationSignal.throwIfAborted();
                                const result = await nativeSessions.execute(command, operationSignal);
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, result);
                                }
                            } catch (error) {
                                const failure: unknown = operationSignal.aborted
                                    ? (controller.signal.reason ??
                                      new AcpExecutionError(
                                          "Native session operation cancelled",
                                          {},
                                          "native_session_cancelled",
                                      ))
                                    : error;
                                audit.record({
                                    commandId: command.requestId,
                                    sessionId: command.sessionId,
                                    event: "native_session_operation_failed",
                                    details: { code: operationErrorCode(failure) },
                                });
                                diagnostics.daemonDiagnostic(
                                    "native_session_operation_failed",
                                    command.requestId,
                                    {
                                        action: command.action,
                                        agentId: command.agentId,
                                        code: operationErrorCode(failure),
                                        sessionId: command.sessionId,
                                    },
                                    failure,
                                );
                                reportOperationFailure(socket, command.requestId, command.sessionId, failure);
                            } finally {
                                timeout.cancel();
                                nativeRequests.delete(command.requestId);
                            }
                        })();
                        nativeRequests.set(command.requestId, {
                            agentId: command.agentId,
                            sessionId: command.sessionId,
                            controller,
                            completion,
                        });
                        return;
                    }
                    if (kind === NATIVE_SESSION_TURN_FORK_KIND) {
                        const command = message;
                        const previous = [...nativeRequests.values()].filter(
                            (request) => request.agentId === command.agentId,
                        );
                        if (
                            nativeRequests.has(command.requestId) ||
                            nativeRequests.size >= 4 ||
                            previous.some((request) => !request.controller.signal.aborted)
                        ) {
                            reportOperationFailure(
                                socket,
                                command.requestId,
                                command.sessionId,
                                new AcpExecutionError(
                                    "Another native session operation is running",
                                    {},
                                    "native_session_busy",
                                ),
                            );
                            return;
                        }
                        const controller = new AbortController();
                        const operationSignal = AbortSignal.any([connectionController.signal, controller.signal]);
                        const timeout = timer.schedule(
                            () =>
                                controller.abort(
                                    new AcpExecutionError(
                                        "Native session operation timed out",
                                        {},
                                        "native_session_timeout",
                                    ),
                                ),
                            90_000,
                        );
                        const completion = (async (): Promise<void> => {
                            try {
                                operationSignal.throwIfAborted();
                                if (previous.length > 0) {
                                    await new Promise<void>((resolve, reject) => {
                                        const cancel = (): void => reject(operationSignal.reason);
                                        operationSignal.addEventListener("abort", cancel, { once: true });
                                        void Promise.all(previous.map((request) => request.completion)).then(
                                            () => {
                                                operationSignal.removeEventListener("abort", cancel);
                                                resolve();
                                            },
                                            (error: unknown) => {
                                                operationSignal.removeEventListener("abort", cancel);
                                                reject(error);
                                            },
                                        );
                                    });
                                }
                                operationSignal.throwIfAborted();
                                const result = await nativeSessions.executeTurnFork(command, operationSignal);
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, result);
                                }
                            } catch (error) {
                                const failure: unknown = operationSignal.aborted
                                    ? (controller.signal.reason ??
                                      new AcpExecutionError(
                                          "Native session operation cancelled",
                                          {},
                                          "native_session_cancelled",
                                      ))
                                    : error;
                                audit.record({
                                    commandId: command.requestId,
                                    details: { code: operationErrorCode(failure) },
                                    event: "native_session_turn_fork_failed",
                                    sessionId: command.sessionId,
                                });
                                diagnostics.daemonDiagnostic(
                                    "native_session_turn_fork_failed",
                                    command.requestId,
                                    {
                                        agentId: command.agentId,
                                        code: operationErrorCode(failure),
                                        sessionId: command.sessionId,
                                    },
                                    failure,
                                );
                                reportOperationFailure(socket, command.requestId, command.sessionId, failure);
                            } finally {
                                timeout.cancel();
                                nativeRequests.delete(command.requestId);
                            }
                        })();
                        nativeRequests.set(command.requestId, {
                            agentId: command.agentId,
                            completion,
                            controller,
                            sessionId: command.sessionId,
                        });
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
                            settleAbandonedTurn(publisher, outbox, audit, cancellation);
                            return;
                        }
                        if (!turn.requestCancellation()) {
                            return;
                        }
                        audit.record({
                            commandId: cancellation.commandId,
                            event: "session_cancellation_requested",
                            sessionId: cancellation.sessionId,
                        });
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

                    const receipt = outbox.claimExecution(command.commandId, command.sessionId, encoded);
                    if (receipt.kind === "duplicate") {
                        return;
                    }

                    const turn = new ActiveDaemonTurn(command, receipt.attemptId);
                    activeTurns.set(command.commandId, turn);
                    void executePrompt(
                        outbox,
                        publisher,
                        command,
                        config,
                        directories,
                        audit,
                        sessions,
                        receipt.attemptId,
                        () => {
                            if (command.disposition !== SessionPromptDisposition.Steer) {
                                activeAttemptIds.set(command.sessionId, receipt.attemptId);
                            }
                        },
                        timer,
                        turn.signal,
                    )
                        .catch((error: unknown) => {
                            console.error("Mobius daemon turn failed", error);
                        })
                        .finally(() => {
                            activeTurns.delete(command.commandId);
                            if (activeAttemptIds.get(command.sessionId) === receipt.attemptId) {
                                activeAttemptIds.delete(command.sessionId);
                            }
                            turn.finish();
                        });
                } catch (error) {
                    console.error("Mobius daemon rejected a message", error);
                    if (error instanceof RuntimeDeliveryInboxCapacityError) {
                        failAndClose(error, 4013, "Runtime delivery queue full", "delivery_backpressure");
                        return;
                    }
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
                    resumeRuntimeDeliveries();
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
                        resumeRuntimeDeliveries();
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
            ...[...nativeRequests.values()].map((request) => request.completion),
            ...[...agentSettingsDiscoveries.values()].map((request) => request.completion),
            ...[...agentCatalogRefreshes.values()].map((request) => request.completion),
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
    const outbox = new SessionEventOutbox();
    const publisher = new DaemonSessionEventPublisher(outbox, timer);
    const activeTurns = new Map<string, ActiveDaemonTurn>();
    const activeAttemptIds = new Map<string, string>();
    const recordSessionEvent = (sessionId: string, event: RecordedSessionEvent): void => {
        const attemptId = activeAttemptIds.get(sessionId);
        if (attemptId === undefined) {
            publisher.recordRuntime(sessionId, event);
            return;
        }
        publisher.recordAttempt(sessionId, event, attemptId);
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
    const nativeSessions = new NativeSessionService(config, directories, sessions, audit);
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
                    outbox,
                    publisher,
                    activeTurns,
                    activeAttemptIds,
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
                            outbox.close();
                        }
                    }
                }
            }
        }
    }
}
