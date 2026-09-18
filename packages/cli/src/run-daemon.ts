import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { styleText } from "node:util";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_DEFAULT_EXECUTION_SETTING,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentContentEvent,
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    BOT_SESSION_PROMPT_KIND,
    type BotSessionPromptCommand,
    decodeAgentInstallCancelCommand,
    decodeAgentInstallRequestCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeBotSessionPromptCommand,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionTurnForkCommand,
    decodeRuntimeDelivery,
    decodeRuntimeDeliveryCommitted,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionEventAcknowledgement,
    decodeSessionEventDeferred,
    decodeSessionEventEnvelope,
    decodeSessionEventRejection,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeAgentActivityEvent,
    encodeAgentContentEvent,
    encodeAgentInstallCancelledEvent,
    encodeAgentInstallCompletedEvent,
    encodeAgentInstallFailedEvent,
    encodeAgentInstallProgressEvent,
    encodeAgentInstallStartedEvent,
    encodeAgentMessageDeltaEvent,
    encodeAgentSettingsDiscoveredEvent,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeNativeSessionResult,
    encodeRuntimeDeliveryReceived,
    encodeSessionCommandsUpdatedEvent,
    encodeSessionCompletedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionElicitationRequestedEvent,
    encodeSessionElicitationResolvedEvent,
    encodeSessionFailedEvent,
    encodeSessionInfoUpdatedEvent,
    encodeSessionOperationFailedEvent,
    encodeSessionPermissionRequestedEvent,
    encodeSessionPermissionResolvedEvent,
    encodeSessionReadyEvent,
    encodeSessionStartedEvent,
    encodeSessionUsageUpdatedEvent,
    encodeWorkspaceEntriesEvent,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_TURN_FORK_KIND,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type RuntimeDelivery,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionCancelCommand,
    type SessionCommandsUpdatedEvent,
    type SessionConfigOption,
    type SessionConfigUpdatedEvent,
    type SessionConfigurationSelection,
    type SessionConfigureCommand,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionPrepareCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionReadyEvent,
    type SessionUsageUpdatedEvent,
    WORKSPACE_LIST_KIND,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { fetch, type MessageEvent, WebSocket } from "undici";

import type { AcpActivity } from "./acp/activity.ts";
import { AcpExecutionError, AcpSessionManager, type AcpSessionObserver } from "./acp/session-manager.ts";
import { SqliteAcpSessionStore } from "./acp/session-store.ts";
import { supportedLocalAgentSpecifications } from "./agent-catalog/discover-local-agents.ts";
import {
    AgentIntegrationDefinition,
    LocalAgentCatalogError,
    LocalAgentDefinition,
} from "./agent-catalog/local-agent.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import {
    type AgentInstallation,
    AgentInstallationManager,
    CancelledInstallation,
    FailedInstallation,
    type InstallationAudit,
    type InstallationObserver,
    RequestedInstallation,
    RunningInstallation,
    SucceededInstallation,
} from "./agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "./agent-installation/fixed-installation-executor.ts";
import { uploadRuntimeArtifact } from "./artifacts/runtime-artifact-uploader.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import type { LocalArtifact } from "./authorization/local-artifact.ts";
import { LocalAuthorizationError } from "./authorization/local-authorization-error.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import { EmbeddedBotContextApplicator } from "./bots/bot-context-applicator.ts";
import { BotExecutionContextRegistry } from "./bots/bot-execution-context.ts";
import { BotOutboundIpcServer } from "./bots/bot-outbound-ipc.ts";
import { LocalBotAuthorizationError, LocalBotExecutionAuthorizer } from "./bots/local-bot-execution-authorizer.ts";
import type { DaemonConfig } from "./config.ts";
import { AccumulatingOperationMetrics, type DurationMetric } from "./infra/operation-metrics.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { environmentProxyDispatcher } from "./network/environment-proxy.ts";
import { PromptArtifactError, resolvePromptArtifacts } from "./prompt-artifact-resolver.ts";
import { connectRelay } from "./relay-connection/connect.ts";
import { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import { RelayConnectionLiveness } from "./relay-connection/liveness.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "./relay-connection/runtime-authentication.ts";
import { RuntimeDeliveryInboxCapacityError, SessionEventOutbox } from "./relay-connection/session-event-outbox.ts";
import { type DaemonScheduledTask, type DaemonTimer, systemDaemonTimer } from "./relay-connection/timer.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;
const AGENT_ACTIVITY_COALESCING_MILLISECONDS = 100;
const ACTIVE_TURN_RECONCILIATION_TIMEOUT_MILLISECONDS = 20_000;
const ACTIVE_TURN_RECONCILIATION_CLOSE_CODE = 4009;

function botIpcSocketPath(): string {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\mobius-bot-${randomUUID()}`;
    }
    return join("/tmp", `mobius-bot-${randomUUID()}.sock`);
}

class DaemonAcpObserver implements AcpSessionObserver {
    readonly #config: DaemonConfig;
    readonly #record: (sessionId: string, payload: string) => void;

    constructor(config: DaemonConfig, record: (sessionId: string, payload: string) => void) {
        this.#config = config;
        this.#record = record;
    }

    readonly importLocalArtifact = async (
        sessionId: string,
        artifact: LocalArtifact,
        signal: AbortSignal,
    ): Promise<string> => {
        try {
            return (await uploadRuntimeArtifact(this.#config, sessionId, artifact, signal)).artifactId;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof Error && cause.name === "AbortError") {
                throw cause;
            }
            return "";
        }
    };

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionCommandsUpdatedEvent(event));
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionConfigUpdatedEvent(event));
        return Promise.resolve();
    };

    readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.#record(event.sessionId, encodeAgentContentEvent(event));
        return Promise.resolve();
    };

    readonly onElicitation = (event: SessionElicitationRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionElicitationRequestedEvent(event));
        return Promise.resolve();
    };

    readonly onElicitationResolved = (event: SessionElicitationResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionElicitationResolvedEvent(event));
        return Promise.resolve();
    };

    readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionInfoUpdatedEvent(event));
        return Promise.resolve();
    };

    readonly onPermission = (event: SessionPermissionRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionPermissionRequestedEvent(event));
        return Promise.resolve();
    };

    readonly onPermissionResolved = (event: SessionPermissionResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionPermissionResolvedEvent(event));
        return Promise.resolve();
    };

    readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, encodeSessionUsageUpdatedEvent(event));
        return Promise.resolve();
    };
}

class AuditInstallationEvents implements InstallationAudit {
    readonly #audit: AuditStore;

    constructor(audit: AuditStore) {
        this.#audit = audit;
    }

    readonly record = (
        event: string,
        requestId: string,
        agentId: string,
        details: Readonly<Record<string, string>> = {},
    ): void => {
        this.#audit.record({
            commandId: requestId,
            details,
            event,
            sessionId: `agent-installation:${agentId}`,
        });
    };
}

class DaemonInstallationObserver implements InstallationObserver {
    readonly #started = new Set<string>();
    #socket: WebSocket | null = null;

    readonly connect = (socket: WebSocket): void => {
        this.#socket = socket;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
        }
    };

    readonly #send = (socket: WebSocket, message: string): void => {
        try {
            send(socket, message);
        } catch {
            if (this.#socket === socket) {
                this.#socket = null;
            }
        }
    };

    readonly onState = (state: AgentInstallation): Promise<void> => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (state instanceof RequestedInstallation) {
            return Promise.resolve();
        }
        if (state instanceof RunningInstallation) {
            if (!this.#started.has(state.requestId)) {
                this.#started.add(state.requestId);
                this.#send(
                    socket,
                    encodeAgentInstallStartedEvent({
                        agentId: state.agentId,
                        kind: AGENT_INSTALL_STARTED_KIND,
                        requestId: state.requestId,
                    }),
                );
            }
            this.#send(
                socket,
                encodeAgentInstallProgressEvent({
                    agentId: state.agentId,
                    kind: AGENT_INSTALL_PROGRESS_KIND,
                    requestId: state.requestId,
                    stage: state.stage,
                }),
            );
            return Promise.resolve();
        }
        if (state instanceof SucceededInstallation) {
            this.#send(
                socket,
                encodeAgentInstallCompletedEvent({
                    agentId: state.agentId,
                    authenticationMayBeRequired: state.authenticationMayBeRequired,
                    kind: AGENT_INSTALL_COMPLETED_KIND,
                    requestId: state.requestId,
                }),
            );
            return Promise.resolve();
        }
        if (state instanceof FailedInstallation) {
            this.#send(
                socket,
                encodeAgentInstallFailedEvent({
                    agentId: state.agentId,
                    code: state.code,
                    kind: AGENT_INSTALL_FAILED_KIND,
                    message: state.message,
                    requestId: state.requestId,
                }),
            );
            return Promise.resolve();
        }
        if (state instanceof CancelledInstallation) {
            this.#send(
                socket,
                encodeAgentInstallCancelledEvent({
                    agentId: state.agentId,
                    kind: AGENT_INSTALL_CANCELLED_KIND,
                    requestId: state.requestId,
                }),
            );
            return Promise.resolve();
        }
        throw new Error("Unsupported Agent integration installation state");
    };
}

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

interface DaemonTurnCommand {
    readonly commandId: string;
    readonly sessionId: string;
}

class ActiveDaemonTurn {
    readonly attemptId: string;
    readonly command: DaemonTurnCommand;
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    #cancellationRequested = false;

    constructor(command: DaemonTurnCommand, attemptId: string) {
        this.attemptId = attemptId;
        this.command = command;
        this.#controller = new AbortController();
    }

    readonly abortDaemon = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => this.#finished.resolve();

    readonly matches = (cancellation: SessionCancelCommand): boolean =>
        cancellation.commandId === this.command.commandId && cancellation.sessionId === this.command.sessionId;

    readonly requestCancellation = (): boolean => {
        if (this.#cancellationRequested) {
            return false;
        }
        this.#cancellationRequested = true;
        return true;
    };

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}

class ActiveTurnReconciliationError extends Error {
    readonly code = "active_turn_reconciliation_failed";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "ActiveTurnReconciliationError";
    }
}

function activeTurnReconciliationEndpoint(config: DaemonConfig, turn: ActiveDaemonTurn): URL {
    const endpoint = relayHttpEndpoint(config.relayUrl);
    let channelPath = "";
    if (endpoint.pathname.endsWith("/daemon")) {
        channelPath = endpoint.pathname.slice(0, -"/daemon".length);
    } else {
        const runtimePath = "/v1/runtimes/connect";
        if (!endpoint.pathname.endsWith(runtimePath)) {
            throw new ActiveTurnReconciliationError("The Relay URL is invalid");
        }
        channelPath = `${endpoint.pathname.slice(0, -runtimePath.length)}/channels/${encodeURIComponent(config.channelId)}`;
    }
    endpoint.pathname = `${channelPath}/sessions/${encodeURIComponent(turn.command.sessionId)}/attempts/${encodeURIComponent(turn.attemptId)}/reconciliation`;
    return endpoint;
}

async function reconcileActiveTurn(config: DaemonConfig, turn: ActiveDaemonTurn, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(ACTIVE_TURN_RECONCILIATION_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
        response = await fetch(activeTurnReconciliationEndpoint(config, turn), {
            body: JSON.stringify({ outcome: { kind: "running" } }),
            dispatcher: environmentProxyDispatcher,
            headers: { ...runtimeAuthorization(config.relayUrl), "content-type": "application/json" },
            method: "POST",
            signal: requestSignal,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        throw new ActiveTurnReconciliationError(
            timeoutSignal.aborted
                ? "The active Agent turn reconciliation timed out"
                : "The active Agent turn could not be reconciled",
            { cause: error },
        );
    }
    await response.body?.cancel();
    if (!response.ok) {
        throw new ActiveTurnReconciliationError(
            `The Relay rejected the active Agent turn reconciliation with status ${response.status.toString()}`,
        );
    }
}

async function reconcileActiveTurns(
    config: DaemonConfig,
    turns: readonly ActiveDaemonTurn[],
    signal: AbortSignal,
): Promise<void> {
    await Promise.all(turns.map(async (turn) => await reconcileActiveTurn(config, turn, signal)));
}

function send(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(message);
}

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

abstract class DaemonSessionEventConnectionState {
    abstract readonly disconnect: (socket: WebSocket) => DaemonSessionEventConnectionState;
    abstract readonly matches: (socket: WebSocket) => boolean;
    abstract readonly send: (message: string) => boolean;
}

class DisconnectedDaemonSessionEventState extends DaemonSessionEventConnectionState {
    readonly disconnect = (): DaemonSessionEventConnectionState => this;
    readonly matches = (): boolean => false;
    readonly send = (): boolean => false;
}

class ConnectedDaemonSessionEventState extends DaemonSessionEventConnectionState {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        super();
        this.#socket = socket;
    }

    readonly disconnect = (socket: WebSocket): DaemonSessionEventConnectionState =>
        socket === this.#socket ? new DisconnectedDaemonSessionEventState() : this;

    readonly matches = (socket: WebSocket): boolean => socket === this.#socket;

    readonly send = (message: string): boolean => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.#socket.send(message);
            return true;
        } catch {
            // The durable outbox retains the event for the replacement connection.
            return false;
        }
    };
}

const SESSION_EVENT_REPLAY_WINDOW = 16;
const SESSION_EVENT_SOURCE_REPLAY_WINDOW = 4;
const SESSION_EVENT_REPLAY_BYTE_LIMIT = 32 * 1024 * 1024;

class InFlightSessionEvent {
    readonly byteLength: number;
    readonly sourceKey: string;

    constructor(sourceKey: string, byteLength: number) {
        this.byteLength = byteLength;
        this.sourceKey = sourceKey;
    }
}

function sessionEventSourceKey(envelope: ReturnType<typeof decodeSessionEventEnvelope>): string {
    return envelope.source.kind === "attempt"
        ? `attempt:${envelope.sessionId}:${envelope.source.attemptId}`
        : `runtime:${envelope.sessionId}`;
}

class DaemonSessionEventPublisher {
    readonly #outbox: SessionEventOutbox;
    readonly #inFlightEvents = new Map<string, InFlightSessionEvent>();
    readonly #pausedSources = new Map<string, DaemonScheduledTask>();
    readonly #timer: DaemonTimer;
    #inFlightBytes = 0;
    #connection: DaemonSessionEventConnectionState = new DisconnectedDaemonSessionEventState();

    constructor(outbox: SessionEventOutbox, timer: DaemonTimer) {
        this.#outbox = outbox;
        this.#timer = timer;
    }

    readonly connect = (socket: WebSocket): void => {
        this.#connection = new ConnectedDaemonSessionEventState(socket);
        this.#clearInFlight();
        this.#publishNextBatch();
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (!this.#connection.matches(socket)) {
            return;
        }
        this.#connection = this.#connection.disconnect(socket);
        this.#clearInFlight();
    };

    readonly recordAttempt = (sessionId: string, payload: string, attemptId: string): void => {
        const kind = decodeMessageKind(payload);
        if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
            this.#outbox.enqueueCritical(sessionId, payload, attemptId);
        } else {
            this.#outbox.enqueue(sessionId, payload, attemptId);
        }
        this.#publishNextBatch();
    };

    readonly recordRuntime = (sessionId: string, payload: string): void => {
        this.#outbox.enqueue(sessionId, payload);
        this.#publishNextBatch();
    };

    readonly acknowledge = (acknowledgement: Parameters<SessionEventOutbox["acknowledge"]>[0]): void => {
        if (!this.#outbox.acknowledge(acknowledgement)) {
            return;
        }
        this.#removeInFlight(acknowledgement.eventId);
        this.#publishNextBatch();
    };

    readonly quarantine = (rejection: Parameters<SessionEventOutbox["quarantine"]>[0]): boolean => {
        const quarantined = this.#outbox.quarantine(rejection);
        if (!quarantined) {
            return false;
        }
        this.#removeInFlight(rejection.eventId);
        this.#publishNextBatch();
        return true;
    };

    readonly defer = (deferred: ReturnType<typeof decodeSessionEventDeferred>): void => {
        const inFlight = this.#inFlightEvents.get(deferred.eventId);
        if (inFlight === undefined) {
            return;
        }
        this.#clearInFlightSource(inFlight.sourceKey);
        if (!this.#pausedSources.has(inFlight.sourceKey)) {
            this.#pausedSources.set(
                inFlight.sourceKey,
                this.#timer.schedule(() => {
                    this.#pausedSources.delete(inFlight.sourceKey);
                    this.#publishNextBatch();
                }, deferred.retryAfterMilliseconds),
            );
        }
        this.#publishNextBatch();
    };

    readonly close = (): void => {
        for (const task of this.#pausedSources.values()) {
            task.cancel();
        }
        this.#pausedSources.clear();
        this.#clearInFlight();
    };

    readonly #publishNextBatch = (): void => {
        while (this.#inFlightEvents.size < SESSION_EVENT_REPLAY_WINDOW) {
            const sourceCounts = new Map<string, number>();
            for (const inFlight of this.#inFlightEvents.values()) {
                sourceCounts.set(inFlight.sourceKey, (sourceCounts.get(inFlight.sourceKey) ?? 0) + 1);
            }
            const saturatedSources = [...sourceCounts.entries()]
                .filter(([, count]) => count >= SESSION_EVENT_SOURCE_REPLAY_WINDOW)
                .map(([sourceKey]) => sourceKey);
            const batch = this.#outbox.pendingSourceHeads(
                SESSION_EVENT_REPLAY_WINDOW - this.#inFlightEvents.size,
                [...this.#inFlightEvents.keys()],
                [...this.#pausedSources.keys(), ...saturatedSources],
            );
            let sent = 0;
            for (const encoded of batch) {
                const envelope = decodeSessionEventEnvelope(encoded);
                const sourceKey = sessionEventSourceKey(envelope);
                const sourceCount = sourceCounts.get(sourceKey) ?? 0;
                if (sourceCount >= SESSION_EVENT_SOURCE_REPLAY_WINDOW) {
                    continue;
                }
                const byteLength = new TextEncoder().encode(encoded).byteLength;
                if (this.#inFlightBytes + byteLength > SESSION_EVENT_REPLAY_BYTE_LIMIT) {
                    continue;
                }
                if (!this.#connection.send(encoded)) {
                    this.#clearInFlight();
                    return;
                }
                this.#inFlightEvents.set(envelope.eventId, new InFlightSessionEvent(sourceKey, byteLength));
                this.#inFlightBytes += byteLength;
                sourceCounts.set(sourceKey, sourceCount + 1);
                sent += 1;
            }
            if (sent === 0) {
                return;
            }
        }
    };

    readonly #removeInFlight = (eventId: string): void => {
        const inFlight = this.#inFlightEvents.get(eventId);
        if (inFlight === undefined) {
            return;
        }
        this.#inFlightEvents.delete(eventId);
        this.#inFlightBytes -= inFlight.byteLength;
    };

    readonly #clearInFlight = (): void => {
        this.#inFlightEvents.clear();
        this.#inFlightBytes = 0;
    };

    readonly #clearInFlightSource = (sourceKey: string): void => {
        for (const [eventId, inFlight] of this.#inFlightEvents) {
            if (inFlight.sourceKey !== sourceKey) {
                continue;
            }
            this.#inFlightEvents.delete(eventId);
            this.#inFlightBytes -= inFlight.byteLength;
        }
    };
}

class CoalescingDaemonActivityPublisher {
    readonly #pending = new Map<string, AcpActivity>();
    readonly #publish: (activity: AcpActivity) => void;
    readonly #publishedActivityIds = new Set<string>();
    readonly #scheduled = new Map<string, DaemonScheduledTask>();
    readonly #timer: DaemonTimer;

    constructor(timer: DaemonTimer, publish: (activity: AcpActivity) => void) {
        this.#publish = publish;
        this.#timer = timer;
    }

    readonly flush = (): void => {
        const activities = [...this.#pending.values()].sort((left, right) => left.sequence - right.sequence);
        for (const task of this.#scheduled.values()) {
            task.cancel();
        }
        this.#pending.clear();
        this.#scheduled.clear();
        for (const activity of activities) {
            this.#publish(activity);
        }
    };

    readonly record = (activity: AcpActivity): Promise<void> => {
        if (activity.status !== "pending" && activity.status !== "running") {
            this.#discardPending(activity.activityId);
            this.#publishedActivityIds.add(activity.activityId);
            this.#publish(activity);
            return Promise.resolve();
        }
        if (!this.#publishedActivityIds.has(activity.activityId)) {
            this.#publishedActivityIds.add(activity.activityId);
            this.#publish(activity);
            return Promise.resolve();
        }
        this.#pending.set(activity.activityId, activity);
        if (!this.#scheduled.has(activity.activityId)) {
            this.#scheduled.set(
                activity.activityId,
                this.#timer.schedule(
                    () => this.#flushActivity(activity.activityId),
                    AGENT_ACTIVITY_COALESCING_MILLISECONDS,
                ),
            );
        }
        return Promise.resolve();
    };

    readonly #discardPending = (activityId: string): void => {
        this.#scheduled.get(activityId)?.cancel();
        this.#scheduled.delete(activityId);
        this.#pending.delete(activityId);
    };

    readonly #flushActivity = (activityId: string): void => {
        const activity = this.#pending.get(activityId);
        this.#discardPending(activityId);
        if (activity !== undefined) {
            this.#publish(activity);
        }
    };
}

function encodeDaemonActivity(command: DaemonTurnCommand, activity: AcpActivity): string {
    return encodeAgentActivityEvent({
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
    });
}

function reportFailure(
    publisher: DaemonSessionEventPublisher,
    command: DaemonTurnCommand,
    code: string,
    message: string,
    attemptId: string,
): void {
    publisher.recordAttempt(
        command.sessionId,
        encodeSessionFailedEvent({
            code,
            commandId: command.commandId,
            kind: SESSION_FAILED_KIND,
            message,
            sessionId: command.sessionId,
        }),
        attemptId,
    );
}

function operationErrorCode(error: unknown): string {
    if (
        error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof LocalBotAuthorizationError ||
        error instanceof PromptArtifactError
    ) {
        return error.code;
    }
    return "session_operation_failed";
}

function operationErrorMessage(error: unknown): string {
    if (
        error instanceof AcpExecutionError ||
        error instanceof LocalAuthorizationError ||
        error instanceof LocalAgentCatalogError ||
        error instanceof LocalBotAuthorizationError ||
        error instanceof PromptArtifactError
    ) {
        return error.message;
    }
    return "The local agent operation could not be completed";
}

function reportOperationFailure(
    socket: WebSocket,
    requestId: string,
    sessionId: string,
    error: unknown,
    runtimeTimings: readonly DurationMetric[] = [],
): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    send(
        socket,
        encodeSessionOperationFailedEvent({
            code: operationErrorCode(error),
            kind: "session.operation.failed",
            message: operationErrorMessage(error),
            requestId,
            ...(runtimeTimings.length === 0 ? {} : { runtimeTimings }),
            sessionId,
        }),
    );
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

async function discoverAgentSettings(
    command: AgentSettingsDiscoverCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    sessions: AcpSessionManager,
    signal: AbortSignal,
): Promise<AgentSettingsDiscoveredEvent> {
    const resolved = await resolveSessionDirectories(
        directories,
        config.bindingId,
        command.directoryId,
        command.additionalDirectoryIds,
        signal,
    );
    const agent = config.catalog.find(command.agentId);
    const snapshot = await sessions.inspectAgentSettings({
        additionalDirectories: resolved.additionalDirectories,
        agent,
        cwd: resolved.cwd,
        signal,
    });
    return {
        agentId: command.agentId,
        agentName: snapshot.agentName,
        agentVersion: snapshot.agentVersion,
        configOptions: snapshot.configOptions,
        directoryId: command.directoryId,
        kind: AGENT_SETTINGS_DISCOVERED_KIND,
        requestId: command.requestId,
    };
}

async function executeWorkspaceList(
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
        send(
            socket,
            encodeWorkspaceEntriesEvent({
                bindingId: command.bindingId,
                directoryId: listing.directoryId,
                directoryLabel: listing.directoryLabel,
                entries: listing.entries,
                kind: "workspace.entries",
                parentDirectoryId: listing.parentDirectoryId,
                requestId: command.requestId,
            }),
        );
    } catch (error) {
        reportOperationFailure(socket, command.requestId, "", error);
    }
}

async function executeSessionPrepare(
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
                publisher.recordRuntime(
                    command.sessionId,
                    encodeSessionConfigUpdatedEvent({
                        configOptions,
                        kind: "session.config.updated",
                        requestId: command.requestId,
                        sessionId: command.sessionId,
                    }),
                );
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
            metrics.measureSync("readiness-commit", () => {
                publisher.recordRuntime(command.sessionId, encodeSessionReadyEvent(event));
            });
            return event;
        });
        send(
            socket,
            encodeSessionReadyEvent({
                ...readyEvent,
                runtimeTimings: metrics.snapshot(),
            }),
        );
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

async function executeSessionConfigure(
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
        publisher.recordRuntime(
            command.sessionId,
            encodeSessionConfigUpdatedEvent({
                configOptions,
                kind: "session.config.updated",
                requestId: command.requestId,
                sessionId: command.sessionId,
            }),
        );
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(socket, command.requestId, command.sessionId, error);
    }
}

async function executePrompt(
    outbox: SessionEventOutbox,
    publisher: DaemonSessionEventPublisher,
    command: SessionPromptCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    attemptId: string,
    activateAttempt: () => void,
    timer: DaemonTimer,
    signal: AbortSignal,
): Promise<void> {
    const activities = new CoalescingDaemonActivityPublisher(timer, (activity) => {
        publisher.recordAttempt(command.sessionId, encodeDaemonActivity(command, activity), attemptId);
    });
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const agent = config.catalog.find(command.agentId);
        if (
            command.disposition === SessionPromptDisposition.Queue &&
            !outbox.isTerminalExecution(command.targetCommandId, command.sessionId)
        ) {
            throw new AcpExecutionError(
                "The queued prompt target is unavailable",
                {},
                "prompt_queue_target_unavailable",
            );
        }
        if (command.sessionConfigurations !== undefined) {
            const prepared = await sessions.prepareExecutionSession({
                additionalDirectories: resolved.additionalDirectories,
                agent,
                cwd: resolved.cwd,
                sessionId: command.sessionId,
                signal,
            });
            if (command.disposition === SessionPromptDisposition.Steer) {
                assertCompleteSessionConfiguration(prepared.configOptions, command.sessionConfigurations);
            } else {
                await applyCompleteSessionConfiguration(
                    sessions,
                    prepared.configOptions,
                    command.sessionConfigurations,
                    agent,
                    resolved.cwd,
                    resolved.additionalDirectories,
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
        outbox.transitionExecution(command.commandId, "running");
        publisher.recordAttempt(
            command.sessionId,
            encodeSessionStartedEvent({
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId,
                sessionId: command.sessionId,
            }),
            attemptId,
        );
        activateAttempt();
        const attachments = await resolvePromptArtifacts(config, command, signal);
        let stopReason: string;
        if (command.disposition === SessionPromptDisposition.Steer) {
            await sessions.steerPrompt({
                additionalDirectories: resolved.additionalDirectories,
                agent,
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
                agent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                disposition: command.disposition,
                images: attachments.images,
                onActivity: activities.record,
                onText: (text, messageId) => {
                    publisher.recordAttempt(
                        command.sessionId,
                        encodeAgentMessageDeltaEvent({
                            commandId: command.commandId,
                            kind: AGENT_MESSAGE_DELTA_KIND,
                            messageId,
                            sessionId: command.sessionId,
                            text,
                        }),
                        attemptId,
                    );
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

        activities.flush();
        publisher.recordAttempt(
            command.sessionId,
            encodeSessionCompletedEvent({
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: command.sessionId,
                stopReason,
            }),
            attemptId,
        );
        outbox.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
        audit.record({
            commandId: command.commandId,
            event: stopReason === "cancelled" ? "session_cancelled" : "session_completed",
            sessionId: command.sessionId,
        });
    } catch (error) {
        activities.flush();
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
            attemptId,
        );
        outbox.transitionExecution(command.commandId, "failed");
        console.error("Mobius daemon command failed", error);
    }
}

function invalidSessionConfiguration(message: string): AcpExecutionError {
    return new AcpExecutionError(message, {}, "invalid_session_configuration");
}

function validateSessionConfigurationSelection(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): void {
    if (option.type !== selection.valueType) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} changed type`);
    }
    if (option.type === "boolean") {
        if (selection.value.length > 0) {
            throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an invalid value`);
        }
        return;
    }
    if (selection.booleanValue) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an invalid value`);
    }
    if (!option.values.some((value) => value.value === selection.value)) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an unavailable value`);
    }
}

function assertSessionConfigurationSchema(
    options: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
): void {
    if (options.length !== selections.length) {
        throw invalidSessionConfiguration("The Turn configuration does not match the Agent settings schema");
    }
    const selectionsById = new Map(selections.map((selection) => [selection.configId, selection]));
    if (selectionsById.size !== selections.length) {
        throw invalidSessionConfiguration("The Turn configuration contains duplicate Agent settings");
    }
    for (const option of options) {
        const selection = selectionsById.get(option.id);
        if (
            selection === undefined ||
            selection.valueType !== option.type ||
            (option.type === "boolean" && selection.value.length > 0) ||
            (option.type === "select" && selection.booleanValue)
        ) {
            throw invalidSessionConfiguration(`The Turn configuration does not match Agent setting ${option.id}`);
        }
    }
}

function sessionConfigurationMatches(option: SessionConfigOption, selection: SessionConfigurationSelection): boolean {
    validateSessionConfigurationSelection(option, selection);
    return option.type === "boolean"
        ? option.booleanValue === selection.booleanValue
        : option.currentValue === selection.value;
}

function sessionConfigurationPriority(
    selection: SessionConfigurationSelection,
    options: readonly SessionConfigOption[],
): number {
    if (selection.configId === "permission_mode") {
        return 0;
    }
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (selection.configId === "model" || option?.category === "model") {
        return 1;
    }
    if (selection.configId === "reasoning_effort" || option?.category === "thought_level") {
        return 2;
    }
    if (option?.category === "model_config") {
        return 3;
    }
    return 4;
}

function assertCompleteSessionConfiguration(
    options: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
): void {
    assertSessionConfigurationSchema(options, selections);
    const selectionsById = new Map(selections.map((selection) => [selection.configId, selection]));
    for (const option of options) {
        const selection = selectionsById.get(option.id);
        if (selection === undefined || !sessionConfigurationMatches(option, selection)) {
            throw invalidSessionConfiguration(`The Turn configuration does not match Agent setting ${option.id}`);
        }
    }
}

async function applySessionConfigurationSelection(
    sessions: AcpSessionManager,
    options: readonly SessionConfigOption[],
    selection: SessionConfigurationSelection,
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (option === undefined) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} is unavailable`);
    }
    if (sessionConfigurationMatches(option, selection)) {
        return options;
    }
    return await sessions.configureSession({
        additionalDirectories,
        agent,
        booleanValue: selection.booleanValue,
        configId: selection.configId,
        cwd,
        requestId: `cfg_${randomUUID()}`,
        sessionId,
        signal,
        value: selection.value,
        valueType: selection.valueType,
    });
}

async function applyCompleteSessionConfiguration(
    sessions: AcpSessionManager,
    initialOptions: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    sessionId: string,
    signal: AbortSignal,
): Promise<void> {
    assertSessionConfigurationSchema(initialOptions, selections);
    let options = initialOptions;
    const orderedSelections = selections.toSorted((left, right) => {
        const priority =
            sessionConfigurationPriority(left, initialOptions) - sessionConfigurationPriority(right, initialOptions);
        return priority === 0 ? left.configId.localeCompare(right.configId) : priority;
    });
    for (const selection of orderedSelections) {
        options = await applySessionConfigurationSelection(
            sessions,
            options,
            selection,
            agent,
            cwd,
            additionalDirectories,
            sessionId,
            signal,
        );
    }
    assertCompleteSessionConfiguration(options, selections);
}

function botExecutionAgent(
    agent: LocalAgentDefinition,
    contextHandle: string,
    socketPath: string,
): LocalAgentDefinition {
    return new LocalAgentDefinition(
        agent.id,
        agent.label,
        agent.command,
        agent.arguments,
        {
            ...agent.environment,
            MOBIUS_BOT_CONTEXT: contextHandle,
            MOBIUS_BOT_SOCKET: socketPath,
            MOBIUS_RELAY_TOKEN: "",
            MOBIUS_RELAY_URL: "",
        },
        agent.adapterVersion,
        agent.agentVersion,
        agent.adapterIdentity,
        agent.agentIdentity,
        agent.promptTimeoutMilliseconds,
        agent.capabilities,
        agent.permissionProfile,
    );
}

function assertPreparedPermission(configOptions: readonly SessionConfigOption[], permissionMode: string): void {
    const permission = configOptions.find((option) => option.id === "permission_mode");
    if (
        permission === undefined ||
        permission.type !== "select" ||
        (permissionMode !== AGENT_DEFAULT_EXECUTION_SETTING && permission.currentValue !== permissionMode)
    ) {
        throw new AcpExecutionError(
            "The required Agent permission mode is unavailable",
            {},
            "invalid_session_configuration",
        );
    }
}

async function applyRequiredExecutionSelection(
    sessions: AcpSessionManager,
    configOptions: readonly SessionConfigOption[],
    selection: SessionConfigurationSelection,
    category: string,
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    const option = configOptions.find((candidate) => candidate.id === selection.configId);
    if (
        option === undefined ||
        option.type !== "select" ||
        option.category !== category ||
        selection.valueType !== "select" ||
        selection.booleanValue
    ) {
        throw new AcpExecutionError(
            `The required Agent setting ${selection.configId} is unavailable`,
            {},
            "invalid_session_configuration",
        );
    }
    if (selection.value === AGENT_DEFAULT_EXECUTION_SETTING) {
        return configOptions;
    }
    if (!option.values.some((value) => value.value === selection.value)) {
        throw new AcpExecutionError(
            `The required Agent setting ${selection.configId} is unavailable`,
            {},
            "invalid_session_configuration",
        );
    }
    if (option.currentValue === selection.value) {
        return configOptions;
    }
    return await sessions.configureSession({
        additionalDirectories,
        agent,
        booleanValue: false,
        configId: selection.configId,
        cwd,
        requestId: `cfg_${randomUUID()}`,
        sessionId,
        signal,
        value: selection.value,
        valueType: "select",
    });
}

async function executeBotPrompt(
    outbox: SessionEventOutbox,
    publisher: DaemonSessionEventPublisher,
    command: BotSessionPromptCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AcpSessionManager,
    authorizer: LocalBotExecutionAuthorizer,
    contexts: BotExecutionContextRegistry,
    applicator: EmbeddedBotContextApplicator,
    ipc: BotOutboundIpcServer,
    attemptId: string,
    activateAttempt: () => void,
    timer: DaemonTimer,
    signal: AbortSignal,
): Promise<void> {
    const activities = new CoalescingDaemonActivityPublisher(timer, (activity) => {
        publisher.recordAttempt(command.sessionId, encodeDaemonActivity(command, activity), attemptId);
    });
    try {
        const deadline = Date.parse(command.executionDeadlineAt);
        const remaining = deadline - Date.now();
        if (!Number.isSafeInteger(deadline) || remaining <= 0) {
            throw new LocalBotAuthorizationError("turn_expired", "The Bot execution deadline has expired");
        }
        const execution = await authorizer.authorize(command, config.catalog, directories, config.bindingId, signal);
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const attachments = await resolvePromptArtifacts(config, command, signal);
        const applied = await applicator.apply(command, execution, attachments.resources, signal);
        const deadlineSignal = AbortSignal.timeout(remaining);
        const executionSignal = AbortSignal.any([signal, deadlineSignal]);
        const startExecution = (): void => {
            audit.record({
                commandId: command.commandId,
                details: {
                    behaviorRevisionId: command.behaviorRevisionId,
                    bindingId: command.bindingId,
                    botId: command.botId,
                    executionId: command.executionId,
                },
                event: "bot_session_authorized",
                sessionId: command.sessionId,
            });
            outbox.transitionExecution(command.commandId, "running");
            publisher.recordAttempt(
                command.sessionId,
                encodeSessionStartedEvent({
                    attemptId,
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId: command.sessionId,
                }),
                attemptId,
            );
            activateAttempt();
        };
        let stopReason = "steered";
        if (command.disposition === SessionPromptDisposition.Steer) {
            startExecution();
            await sessions.steerPrompt({
                additionalDirectories: resolved.additionalDirectories,
                agent: execution.agent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
                prompt: command.prompt,
                resources: applied.resources,
                sessionId: command.sessionId,
                signal: executionSignal,
                targetCommandId: command.targetCommandId,
            });
        } else {
            if (
                command.disposition === SessionPromptDisposition.Queue &&
                !outbox.isTerminalExecution(command.targetCommandId, command.sessionId)
            ) {
                throw new AcpExecutionError(
                    "The queued Bot prompt target is unavailable",
                    {},
                    "prompt_queue_target_unavailable",
                );
            }
            const lease = contexts.activate(command);
            try {
                const agent = botExecutionAgent(execution.agent, lease.context.contextHandle, ipc.socketPath);
                const prepared = await sessions.prepareExecutionSession({
                    additionalDirectories: resolved.additionalDirectories,
                    agent,
                    cwd: resolved.cwd,
                    sessionId: command.sessionId,
                    signal: executionSignal,
                });
                assertPreparedPermission(prepared.configOptions, execution.executionConfiguration.permissionMode);
                let configOptions = await applyRequiredExecutionSelection(
                    sessions,
                    prepared.configOptions,
                    execution.executionConfiguration.model,
                    "model",
                    agent,
                    resolved.cwd,
                    resolved.additionalDirectories,
                    command.sessionId,
                    executionSignal,
                );
                configOptions = await applyRequiredExecutionSelection(
                    sessions,
                    configOptions,
                    execution.executionConfiguration.reasoningEffort,
                    "thought_level",
                    agent,
                    resolved.cwd,
                    resolved.additionalDirectories,
                    command.sessionId,
                    executionSignal,
                );
                for (const selection of command.sessionConfigurations) {
                    await sessions.configureSession({
                        additionalDirectories: resolved.additionalDirectories,
                        agent,
                        booleanValue: selection.booleanValue,
                        configId: selection.configId,
                        cwd: resolved.cwd,
                        requestId: `cfg_${randomUUID()}`,
                        sessionId: command.sessionId,
                        signal: executionSignal,
                        value: selection.value,
                        valueType: selection.valueType,
                    });
                }
                startExecution();
                const result = await sessions.runPrompt({
                    additionalDirectories: resolved.additionalDirectories,
                    agent,
                    commandId: command.commandId,
                    cwd: resolved.cwd,
                    disposition: command.disposition,
                    images: attachments.images,
                    onActivity: activities.record,
                    onText: (text, messageId) => {
                        publisher.recordAttempt(
                            command.sessionId,
                            encodeAgentMessageDeltaEvent({
                                commandId: command.commandId,
                                kind: AGENT_MESSAGE_DELTA_KIND,
                                messageId,
                                sessionId: command.sessionId,
                                text,
                            }),
                            attemptId,
                        );
                        return Promise.resolve();
                    },
                    prompt: command.prompt,
                    resources: applied.resources,
                    sessionId: command.sessionId,
                    signal: executionSignal,
                    targetCommandId: command.targetCommandId,
                });
                stopReason = result.stopReason;
            } finally {
                lease.release();
            }
        }
        activities.flush();
        publisher.recordAttempt(
            command.sessionId,
            encodeSessionCompletedEvent({
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: command.sessionId,
                stopReason,
            }),
            attemptId,
        );
        outbox.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
        audit.record({
            commandId: command.commandId,
            details: { botId: command.botId, executionId: command.executionId },
            event: stopReason === "cancelled" ? "bot_session_cancelled" : "bot_session_completed",
            sessionId: command.sessionId,
        });
    } catch (error) {
        activities.flush();
        const failure =
            Date.parse(command.executionDeadlineAt) <= Date.now()
                ? new LocalBotAuthorizationError("turn_expired", "The Bot execution deadline has expired", {
                      cause: error,
                  })
                : error;
        audit.record({
            commandId: command.commandId,
            details: {
                botId: command.botId,
                code: operationErrorCode(failure),
                executionId: command.executionId,
            },
            event: "bot_session_failed",
            sessionId: command.sessionId,
        });
        const code = operationErrorCode(failure);
        reportFailure(
            publisher,
            command,
            code === "session_operation_failed" ? "agent_execution_failed" : code,
            code === "session_operation_failed"
                ? "The local agent could not complete the Bot request"
                : operationErrorMessage(failure),
            attemptId,
        );
        outbox.transitionExecution(command.commandId, "failed");
        console.error("Mobius daemon Bot command failed", failure);
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
    authorizer: LocalBotExecutionAuthorizer,
    contexts: BotExecutionContextRegistry,
    applicator: EmbeddedBotContextApplicator,
    ipc: BotOutboundIpcServer,
    activeTurns: Map<string, ActiveDaemonTurn>,
    activeAttemptIds: Map<string, string>,
    connectionEpoch: number,
    diagnostics: RelayConnectionDiagnostics,
    onConnected: () => void,
    signal: AbortSignal,
    timer: DaemonTimer,
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
                const kind = decodeMessageKind(delivery.payload);
                if (kind === SESSION_CANCEL_KIND) {
                    const cancellation = decodeSessionCancelCommand(delivery.payload);
                    if (cancellation.sessionId !== delivery.sessionId) {
                        throw new Error("Runtime delivery Session identity does not match its payload");
                    }
                    const turn = activeTurns.get(cancellation.commandId);
                    if (turn === undefined || !turn.matches(cancellation) || !turn.requestCancellation()) {
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
                    const command = decodeSessionConfigureCommand(delivery.payload);
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
                    const command = decodeSessionPermissionRespondCommand(delivery.payload);
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
                    const command = decodeSessionElicitationRespondCommand(delivery.payload);
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
                if (kind === BOT_SESSION_PROMPT_KIND) {
                    const command = decodeBotSessionPromptCommand(delivery.payload);
                    await processDeliveredPrompt(
                        delivery,
                        command,
                        command.disposition !== SessionPromptDisposition.Steer,
                        (attemptId, activateAttempt, executionSignal) =>
                            executeBotPrompt(
                                outbox,
                                publisher,
                                command,
                                config,
                                directories,
                                audit,
                                sessions,
                                authorizer,
                                contexts,
                                applicator,
                                ipc,
                                attemptId,
                                activateAttempt,
                                timer,
                                executionSignal,
                            ),
                    );
                    return;
                }
                if (kind === SESSION_PROMPT_KIND) {
                    const command = decodeSessionPromptCommand(delivery.payload);
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
                        console.error("Mobius daemon could not process a durable Runtime delivery", error);
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
                const payloadKind = decodeMessageKind(delivery.payload);
                let payloadSessionId = "";
                if (payloadKind === SESSION_CANCEL_KIND) {
                    payloadSessionId = decodeSessionCancelCommand(delivery.payload).sessionId;
                } else if (payloadKind === SESSION_CONFIGURE_KIND) {
                    payloadSessionId = decodeSessionConfigureCommand(delivery.payload).sessionId;
                } else if (payloadKind === SESSION_PERMISSION_RESPOND_KIND) {
                    payloadSessionId = decodeSessionPermissionRespondCommand(delivery.payload).sessionId;
                } else if (payloadKind === SESSION_ELICITATION_RESPOND_KIND) {
                    payloadSessionId = decodeSessionElicitationRespondCommand(delivery.payload).sessionId;
                } else if (payloadKind === SESSION_PROMPT_KIND) {
                    payloadSessionId = decodeSessionPromptCommand(delivery.payload).sessionId;
                } else if (payloadKind === BOT_SESSION_PROMPT_KIND) {
                    payloadSessionId = decodeBotSessionPromptCommand(delivery.payload).sessionId;
                } else {
                    throw new Error("Runtime delivery contains an unsupported protocol message");
                }
                if (payloadSessionId !== delivery.sessionId) {
                    throw new Error("Runtime delivery Session identity does not match its payload");
                }
                const stored = outbox.claimRuntimeDelivery(delivery);
                send(
                    socket,
                    encodeRuntimeDeliveryReceived({
                        deliveryId: delivery.deliveryId,
                        kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                        sessionId: delivery.sessionId,
                    }),
                );
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
                        send(
                            socket,
                            encodeRuntimeDeliveryReceived({
                                deliveryId: stored.deliveryId,
                                kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                                sessionId: stored.sessionId,
                            }),
                        );
                    }
                    processRuntimeDelivery(delivery, stored.state);
                }
            };

            const connectionLiveness = new RelayConnectionLiveness(timer, {
                send: (message) => send(socket, message),
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
                    const kind = decodeMessageKind(encoded);
                    if (kind === RUNTIME_DELIVERY_COMMITTED_KIND) {
                        const committed = decodeRuntimeDeliveryCommitted(encoded);
                        if (!outbox.markRuntimeDeliveryCommitted(committed.deliveryId, committed.sessionId)) {
                            console.warn("Mobius daemon ignored confirmation for an unknown Runtime delivery");
                        }
                        return;
                    }
                    if (kind === RUNTIME_DELIVERY_KIND) {
                        receiveRuntimeDelivery(decodeRuntimeDelivery(encoded));
                        return;
                    }
                    if (kind === SESSION_EVENT_ACK_KIND) {
                        publisher.acknowledge(decodeSessionEventAcknowledgement(encoded));
                        return;
                    }
                    if (kind === SESSION_EVENT_DEFERRED_KIND) {
                        publisher.defer(decodeSessionEventDeferred(encoded));
                        return;
                    }
                    if (kind === SESSION_EVENT_REJECTED_KIND) {
                        const rejection = decodeSessionEventRejection(encoded);
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
                    if (kind === NATIVE_SESSION_CANCEL_KIND) {
                        const command = decodeNativeSessionCancel(encoded);
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
                        const command = decodeAgentSettingsDiscoverCommand(encoded);
                        const existing = [...agentSettingsDiscoveries.values()].find(
                            (request) => request.agentId === command.agentId && !request.controller.signal.aborted,
                        );
                        if (agentSettingsDiscoveries.has(command.requestId) || existing !== undefined) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(
                                    socket,
                                    encodeAgentSettingsDiscoveryFailedEvent({
                                        code: "agent_settings_discovery_busy",
                                        kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                        message: "Another settings discovery is already running for this Agent",
                                        requestId: command.requestId,
                                    }),
                                );
                            }
                            return;
                        }
                        if (agentSettingsDiscoveries.size >= 4) {
                            if (socket.readyState === WebSocket.OPEN) {
                                send(
                                    socket,
                                    encodeAgentSettingsDiscoveryFailedEvent({
                                        code: "agent_settings_discovery_busy",
                                        kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                        message: "Too many Agent settings discoveries are running",
                                        requestId: command.requestId,
                                    }),
                                );
                            }
                            return;
                        }
                        const controller = new AbortController();
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
                                audit.record({
                                    commandId: command.requestId,
                                    details: { agentId: command.agentId, directoryId: command.directoryId },
                                    event: "agent_settings_discovered",
                                    sessionId: `agent-settings:${command.agentId}`,
                                });
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, encodeAgentSettingsDiscoveredEvent(result));
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
                                audit.record({
                                    commandId: command.requestId,
                                    details: { agentId: command.agentId, code: operationErrorCode(failure) },
                                    event: "agent_settings_discovery_failed",
                                    sessionId: `agent-settings:${command.agentId}`,
                                });
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(
                                        socket,
                                        encodeAgentSettingsDiscoveryFailedEvent({
                                            code: operationErrorCode(failure),
                                            kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                            message: operationErrorMessage(failure),
                                            requestId: command.requestId,
                                        }),
                                    );
                                }
                            } finally {
                                timeout.cancel();
                                agentSettingsDiscoveries.delete(command.requestId);
                            }
                        })();
                        agentSettingsDiscoveries.set(command.requestId, {
                            agentId: command.agentId,
                            completion,
                            controller,
                        });
                        return;
                    }
                    if (kind === NATIVE_SESSION_REQUEST_KIND) {
                        const command = decodeNativeSessionCommand(encoded);
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
                                    send(socket, encodeNativeSessionResult(result));
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
                        const command = decodeNativeSessionTurnForkCommand(encoded);
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
                                    send(socket, encodeNativeSessionResult(result));
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
                        decodeRuntimeLivenessReadyEvent(encoded);
                        connectionLiveness.start();
                        return;
                    }
                    if (kind === RUNTIME_HEARTBEAT_ACK_KIND) {
                        connectionLiveness.acknowledge(decodeRuntimeHeartbeatAckEvent(encoded));
                        return;
                    }
                    if (kind === SESSION_CANCEL_KIND) {
                        const cancellation = decodeSessionCancelCommand(encoded);
                        const turn = activeTurns.get(cancellation.commandId);
                        if (turn === undefined || !turn.matches(cancellation)) {
                            console.warn("Mobius daemon ignored cancellation for an inactive turn");
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
                        const command = decodeWorkspaceListCommand(encoded);
                        void executeWorkspaceList(socket, command, directories, audit, connectionController.signal);
                        return;
                    }
                    if (kind === SESSION_PREPARE_KIND) {
                        const command = decodeSessionPrepareCommand(encoded);
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
                        const command = decodeSessionConfigureCommand(encoded);
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
                        const command = decodeSessionPermissionRespondCommand(encoded);
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
                        const command = decodeSessionElicitationRespondCommand(encoded);
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
                        const command = decodeAgentInstallRequestCommand(encoded);
                        void installations.request(command, signal).catch((error: unknown) => {
                            console.error("Mobius Agent integration installation failed", error);
                        });
                        return;
                    }
                    if (kind === AGENT_INSTALL_CANCEL_KIND) {
                        const command = decodeAgentInstallCancelCommand(encoded);
                        void installations.cancel(command.requestId).catch((error: unknown) => {
                            reportOperationFailure(socket, command.requestId, "", error);
                        });
                        return;
                    }
                    if (kind === BOT_SESSION_PROMPT_KIND) {
                        const command = decodeBotSessionPromptCommand(encoded);
                        if (activeTurns.has(command.commandId)) {
                            return;
                        }
                        const receipt = outbox.claimExecution(command.commandId, command.sessionId, encoded);
                        if (receipt.kind === "duplicate") {
                            return;
                        }
                        const turn = new ActiveDaemonTurn(command, receipt.attemptId);
                        activeTurns.set(command.commandId, turn);
                        void executeBotPrompt(
                            outbox,
                            publisher,
                            command,
                            config,
                            directories,
                            audit,
                            sessions,
                            authorizer,
                            contexts,
                            applicator,
                            ipc,
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
                                console.error("Mobius daemon Bot turn failed", error);
                            })
                            .finally(() => {
                                activeTurns.delete(command.commandId);
                                if (activeAttemptIds.get(command.sessionId) === receipt.attemptId) {
                                    activeAttemptIds.delete(command.sessionId);
                                }
                                turn.finish();
                            });
                        return;
                    }
                    if (kind !== SESSION_PROMPT_KIND) {
                        throw new Error("Unsupported protocol message");
                    }
                    const command = decodeSessionPromptCommand(encoded);
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
        ]);
    }
}

export async function runDaemon(
    config: DaemonConfig,
    audit: AuditStore,
    signal: AbortSignal,
    timer: DaemonTimer = systemDaemonTimer,
): Promise<void> {
    const installationAudit = new AuditInstallationEvents(audit);
    const stateDirectory = readStateDirectory();
    const specifications = supportedLocalAgentSpecifications();
    const installationExecutor = new FixedInstallationExecutor({
        defaultWorkspace: config.defaultWorkspace,
        audit: installationAudit,
        catalog: config.catalog,
        environment: process.env,
        publishCatalog: async (installationSignal) => await publishAgentCatalog(config, installationSignal),
        stateDirectory,
    });
    const sessionStore = new SqliteAcpSessionStore(config.auditDatabasePath);
    const outbox = new SessionEventOutbox(config.auditDatabasePath);
    const publisher = new DaemonSessionEventPublisher(outbox, timer);
    const authorizer = new LocalBotExecutionAuthorizer();
    const contexts = new BotExecutionContextRegistry();
    const applicator = new EmbeddedBotContextApplicator();
    const ipc = new BotOutboundIpcServer(botIpcSocketPath(), config.relayUrl, contexts);
    const activeTurns = new Map<string, ActiveDaemonTurn>();
    const activeAttemptIds = new Map<string, string>();
    const recordSessionEvent = (sessionId: string, payload: string): void => {
        const attemptId = activeAttemptIds.get(sessionId);
        if (attemptId === undefined) {
            publisher.recordRuntime(sessionId, payload);
            return;
        }
        publisher.recordAttempt(sessionId, payload, attemptId);
    };
    const sessions = new AcpSessionManager(new DaemonAcpObserver(config, recordSessionEvent), sessionStore);
    const directories = new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace);
    const installationObserver = new DaemonInstallationObserver();
    const diagnostics = new RelayConnectionDiagnostics(audit, config.channelId, config.relayUrl);
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
        if (!connectionAnnounced || !catalogPublished || readinessAnnounced) {
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
        const reconnectCommand = `npx --yes @moxt-ai/mobius start --channel ${config.channelId}`;
        process.stdout.write("Mobius daemon connected to the relay.\n\n");
        process.stdout.write(
            `${styleText(["bold", "yellow"], `Reconnect this channel later:\n  ${reconnectCommand}`)}\n\n`,
        );
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
        await ipc.listen(signal);
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
                    authorizer,
                    contexts,
                    applicator,
                    ipc,
                    activeTurns,
                    activeAttemptIds,
                    connectionEpoch,
                    diagnostics,
                    announceConnection,
                    signal,
                    timer,
                );
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                diagnostics.connectionFailed(connectionEpoch, error, "connection");
            }

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
                        await ipc.close();
                    } finally {
                        try {
                            await sessions.close();
                        } finally {
                            try {
                                sessionStore.close();
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
    }
}
