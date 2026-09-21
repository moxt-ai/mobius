import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { styleText } from "node:util";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_CATALOG_REFRESH_FAILED_KIND,
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentActivityEvent,
    type AgentCatalogRefreshCommand,
    type AgentContentEvent,
    type AgentModelEffort,
    type AgentSetting,
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    type DaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    type decodeSessionEventDeferred,
    decodeSessionEventEnvelope,
    decodeSessionLiveHistoryLoad,
    encodeDaemonToServiceMessage,
    encodeRecordedSessionEvent,
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
    SESSION_COMPLETED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
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
    type SessionEventEnvelope,
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
import {
    AcpConfigurationValueUnavailableError,
    AcpExecutionError,
    AcpSessionManager,
    type AcpSessionObserver,
} from "./acp/session-manager.ts";
import { SqliteAcpSessionStore } from "./acp/session-store.ts";
import { agentSettingsAdapterForAgent, applyAgentLaunchSettings } from "./agent-catalog/agent-settings-adapter.ts";
import {
    discoverLocalAgentInventory,
    supportedLocalAgentSpecifications,
} from "./agent-catalog/discover-local-agents.ts";
import {
    AgentIntegrationDefinition,
    LocalAgentCatalogError,
    type LocalAgentDefinition,
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
import { streamLocalFile } from "./artifacts/local-file-streamer.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { LocalAuthorizationError } from "./authorization/local-authorization-error.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import { type DaemonConfig, DaemonLocalContext, withDaemonEnvironment } from "./config.ts";
import { AccumulatingOperationMetrics, type DurationMetric } from "./infra/operation-metrics.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { environmentProxyDispatcher } from "./network/environment-proxy.ts";
import { revalidateExecutable } from "./process/executable.ts";
import { PromptArtifactError, resolvePromptArtifacts } from "./prompt-artifact-resolver.ts";
import { CoalescingTextPublisher } from "./relay-connection/coalescing-text-publisher.ts";
import { connectRelay } from "./relay-connection/connect.ts";
import { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import { RelayConnectionLiveness } from "./relay-connection/liveness.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "./relay-connection/runtime-authentication.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./relay-connection/runtime-revocation.ts";
import { RuntimeDeliveryInboxCapacityError, SessionEventOutbox } from "./relay-connection/session-event-outbox.ts";
import { type DaemonScheduledTask, type DaemonTimer, systemDaemonTimer } from "./relay-connection/timer.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;
const AGENT_ACTIVITY_COALESCING_MILLISECONDS = 100;
const AGENT_TEXT_COALESCING_MILLISECONDS = 100;
// Mirrors the protocol's per-event text limit; a delta larger than this is
// rejected by the Session event codec rather than truncated.
const AGENT_TEXT_MAXIMUM_LENGTH = 100_000;
const ACTIVE_TURN_RECONCILIATION_TIMEOUT_MILLISECONDS = 20_000;
const ACTIVE_TURN_RECONCILIATION_CLOSE_CODE = 4009;

class DaemonAcpObserver implements AcpSessionObserver {
    readonly #record: (sessionId: string, event: RecordedSessionEvent) => void;

    constructor(record: (sessionId: string, event: RecordedSessionEvent) => void) {
        this.#record = record;
    }

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onElicitation = (event: SessionElicitationRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onElicitationResolved = (event: SessionElicitationResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onPermission = (event: SessionPermissionRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onPermissionResolved = (event: SessionPermissionResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
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

    readonly #send = (socket: WebSocket, message: DaemonToServiceMessage): void => {
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
                this.#send(socket, {
                    agentId: state.agentId,
                    kind: AGENT_INSTALL_STARTED_KIND,
                    requestId: state.requestId,
                });
            }
            this.#send(socket, {
                agentId: state.agentId,
                kind: AGENT_INSTALL_PROGRESS_KIND,
                requestId: state.requestId,
                stage: state.stage,
            });
            return Promise.resolve();
        }
        if (state instanceof SucceededInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                authenticationMayBeRequired: state.authenticationMayBeRequired,
                kind: AGENT_INSTALL_COMPLETED_KIND,
                requestId: state.requestId,
            });
            return Promise.resolve();
        }
        if (state instanceof FailedInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                code: state.code,
                kind: AGENT_INSTALL_FAILED_KIND,
                message: state.message,
                requestId: state.requestId,
            });
            return Promise.resolve();
        }
        if (state instanceof CancelledInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                kind: AGENT_INSTALL_CANCELLED_KIND,
                requestId: state.requestId,
            });
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
    readonly diagnosticDetails: Readonly<Record<string, string>>;
    readonly relayErrorCode: string | null;
    readonly terminal: boolean;

    constructor(
        message: string,
        options: ErrorOptions & { readonly relayErrorCode?: string | null; readonly terminal?: boolean } = {},
    ) {
        super(message, options);
        this.name = "ActiveTurnReconciliationError";
        this.relayErrorCode = options.relayErrorCode ?? null;
        this.terminal = options.terminal ?? false;
        this.diagnosticDetails = this.relayErrorCode === null ? {} : { relayErrorCode: this.relayErrorCode };
    }
}

/**
 * The Relay reports a reconciliation conflict when the Attempt is no longer owned by this Runtime or has
 * already reached a terminal state. Retrying cannot change that outcome, so the daemon must abandon the
 * stale turn instead of replacing its connection forever.
 */
const TERMINAL_RECONCILIATION_RELAY_CODES = new Set(["session_conflict"]);

async function relayErrorCode(response: Awaited<ReturnType<typeof fetch>>): Promise<string | null> {
    try {
        const body: unknown = JSON.parse(await response.text());
        if (typeof body !== "object" || body === null) {
            return null;
        }
        const error = Reflect.get(body, "error");
        if (typeof error !== "object" || error === null) {
            return null;
        }
        const code = Reflect.get(error, "code");
        return typeof code === "string" && code.length > 0 ? code : null;
    } catch {
        return null;
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
    if (!response.ok) {
        const errorCode = await relayErrorCode(response);
        const terminal = errorCode !== null && TERMINAL_RECONCILIATION_RELAY_CODES.has(errorCode);
        throw new ActiveTurnReconciliationError(
            terminal
                ? `The Relay reported that the active Agent turn can no longer be reconciled (${errorCode})`
                : `The Relay rejected the active Agent turn reconciliation with status ${response.status.toString()}`,
            { relayErrorCode: errorCode, terminal },
        );
    }
    await response.body?.cancel();
}

async function reconcileActiveTurns(
    config: DaemonConfig,
    turns: readonly ActiveDaemonTurn[],
    signal: AbortSignal,
): Promise<void> {
    await Promise.all(turns.map(async (turn) => await reconcileActiveTurn(config, turn, signal)));
}

function send(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encodeDaemonToServiceMessage(message));
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
    abstract readonly send: (message: SessionEventEnvelope) => boolean;
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

    readonly send = (message: SessionEventEnvelope): boolean => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.#socket.send(encodeDaemonToServiceMessage(message));
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

    readonly recordAttempt = (sessionId: string, event: RecordedSessionEvent, attemptId: string): void => {
        const encoded = encodeRecordedSessionEvent(event);
        if (event.kind === SESSION_COMPLETED_KIND || event.kind === SESSION_FAILED_KIND) {
            this.#outbox.enqueueCritical(sessionId, encoded, attemptId);
        } else {
            this.#outbox.enqueue(sessionId, encoded, attemptId);
        }
        this.#publishNextBatch();
    };

    readonly recordRuntime = (sessionId: string, event: RecordedSessionEvent): void => {
        this.#outbox.enqueue(sessionId, encodeRecordedSessionEvent(event));
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
                if (!this.#connection.send(envelope)) {
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

function reportFailure(
    publisher: DaemonSessionEventPublisher,
    command: DaemonTurnCommand,
    code: string,
    message: string,
    attemptId: string,
): void {
    publisher.recordAttempt(
        command.sessionId,
        {
            code,
            commandId: command.commandId,
            kind: SESSION_FAILED_KIND,
            message,
            sessionId: command.sessionId,
        },
        attemptId,
    );
}

function operationErrorCode(error: unknown): string {
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

function operationErrorMessage(error: unknown): string {
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

function agentSettingsFailureDetails(agentId: string, failure: unknown): Readonly<Record<string, string>> {
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

interface AgentSettingsDiscovery {
    readonly event: AgentSettingsDiscoveredEvent;
    readonly unsupportedModels: readonly AcpConfigurationValueUnavailableError[];
}

const OPENCODE_PROVIDER_SETTLEMENT_MILLISECONDS = 1_000;

async function waitForAgentSettingsReadiness(agentId: string, signal: AbortSignal, timer: DaemonTimer): Promise<void> {
    if (agentId !== "opencode") {
        return;
    }
    // OpenCode ACP snapshots the first non-empty model catalog, before asynchronously loaded custom providers settle.
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
        const readiness = timer.schedule(finish, OPENCODE_PROVIDER_SETTLEMENT_MILLISECONDS);

        function finish(): void {
            readiness.cancel();
            signal.removeEventListener("abort", finish);
            resolve();
        }

        signal.addEventListener("abort", finish, { once: true });
    });
    signal.throwIfAborted();
}

function isUnavailableModel(
    cause: unknown,
    modelSettingId: string,
    requestedModel: string,
): cause is AcpConfigurationValueUnavailableError {
    return (
        cause instanceof AcpConfigurationValueUnavailableError &&
        cause.configId === modelSettingId &&
        cause.requestedValue === requestedModel
    );
}

function unsupportedModelIds(unsupportedModels: readonly AcpConfigurationValueUnavailableError[]): readonly string[] {
    return [...new Set(unsupportedModels.map((item) => item.requestedValue))];
}

async function discoverAgentSettings(
    command: AgentSettingsDiscoverCommand,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    sessions: AcpSessionManager,
    signal: AbortSignal,
    timer: DaemonTimer,
): Promise<AgentSettingsDiscovery> {
    const agent = config.catalog.find(command.agentId);
    const cwd = await directories.resolve(config.bindingId, "default", signal);
    await waitForAgentSettingsReadiness(agent.id, signal, timer);
    const baseSnapshot = await sessions.inspectAgentSettings({
        additionalDirectories: [],
        agent,
        cwd,
        signal,
    });
    const baseModel = modelOption(baseSnapshot.configOptions);
    const unsupportedModels: AcpConfigurationValueUnavailableError[] = [];
    let selectedSnapshot = baseSnapshot;
    if (command.model !== undefined) {
        if (
            baseModel === undefined ||
            baseModel.type !== "select" ||
            !baseModel.values.some((value) => value.value === command.model)
        ) {
            unsupportedModels.push(
                new AcpConfigurationValueUnavailableError(
                    baseModel?.id ?? "model",
                    command.model,
                    baseModel?.values.map((value) => value.value) ?? [],
                ),
            );
        } else {
            try {
                selectedSnapshot = await sessions.inspectAgentSettings({
                    additionalDirectories: [],
                    agent,
                    cwd,
                    model: command.model,
                    signal,
                });
            } catch (cause) {
                signal.throwIfAborted();
                if (!isUnavailableModel(cause, baseModel.id, command.model)) {
                    throw cause;
                }
                unsupportedModels.push(cause);
            }
        }
    }
    const adapter = agentSettingsAdapterForAgent(agent.id);
    const modelEffort = await discoverModelEffort(
        command,
        agent,
        adapter.modelEffortResolution,
        baseSnapshot.configOptions,
        selectedSnapshot.configOptions,
        unsupportedModels,
        cwd,
        sessions,
        signal,
    );
    const baseSettings = withoutUnsupportedModels(
        settingsFromSnapshot(agent, baseSnapshot.configOptions),
        baseModel?.id ?? "",
        modelEffort.unsupportedModelIds,
    );
    const settings = withoutUnsupportedModels(
        settingsFromSnapshot(agent, selectedSnapshot.configOptions),
        baseModel?.id ?? "",
        modelEffort.unsupportedModelIds,
    );
    return {
        event: {
            agentId: command.agentId,
            agentName: selectedSnapshot.agentName,
            agentVersion: selectedSnapshot.agentVersion,
            kind: AGENT_SETTINGS_DISCOVERED_KIND,
            modelEffort,
            requestId: command.requestId,
            settings,
            settingsRevision: settingsRevision(agent, baseSnapshot.agentVersion, baseSettings, modelEffort),
        },
        unsupportedModels,
    };
}

function settingFromOption(option: SessionConfigOption): AgentSetting {
    return {
        booleanValue: option.booleanValue,
        category: option.category,
        defaultValue: option.type === "boolean" ? "" : option.currentValue,
        description: option.description,
        id: option.id,
        name: option.name,
        type: option.type,
        values: option.values,
    };
}

function settingsFromSnapshot(
    agent: LocalAgentDefinition,
    configOptions: readonly SessionConfigOption[],
): readonly AgentSetting[] {
    const settings = [
        ...agentSettingsAdapterForAgent(agent.id).settings(agent).map(settingFromOption),
        ...configOptions.map(settingFromOption),
    ];
    const identifiers = new Set<string>();
    for (const setting of settings) {
        if (identifiers.has(setting.id)) {
            throw new AcpExecutionError(
                "The Agent returned duplicate setting identifiers",
                {},
                "invalid_session_configuration",
            );
        }
        identifiers.add(setting.id);
    }
    if (settings.length > 128) {
        throw new AcpExecutionError("The Agent returned too many settings", {}, "invalid_session_configuration");
    }
    return settings;
}

function withoutUnsupportedModels(
    settings: readonly AgentSetting[],
    modelSettingId: string,
    unsupportedModelIds: readonly string[],
): readonly AgentSetting[] {
    if (modelSettingId.length === 0 || unsupportedModelIds.length === 0) {
        return settings;
    }
    const unsupported = new Set(unsupportedModelIds);
    return settings.map((setting) => {
        if (setting.id !== modelSettingId || setting.type !== "select") {
            return setting;
        }
        return {
            ...setting,
            defaultValue: unsupported.has(setting.defaultValue) ? "" : setting.defaultValue,
            values: setting.values.filter((value) => !unsupported.has(value.value)),
        };
    });
}

function modelOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
    return options.find((option) => option.id === "model" || option.category === "model");
}

function effortOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
    return options.find((option) => option.id === "reasoning_effort" || option.category === "thought_level");
}

function unavailableModelEffort(): AgentModelEffort {
    return {
        effortSettingId: "",
        modelSettingId: "",
        resolution: AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
        unsupportedModelIds: [],
        valuesByModel: {},
    };
}

async function discoverModelEffort(
    command: AgentSettingsDiscoverCommand,
    agent: LocalAgentDefinition,
    resolution: string,
    initialOptions: readonly SessionConfigOption[],
    selectedOptions: readonly SessionConfigOption[],
    initiallyUnsupportedModels: AcpConfigurationValueUnavailableError[],
    cwd: string,
    sessions: AcpSessionManager,
    signal: AbortSignal,
): Promise<AgentModelEffort> {
    const model = modelOption(initialOptions);
    const unsupportedModels = initiallyUnsupportedModels;
    if (
        resolution !== AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE &&
        resolution !== AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION
    ) {
        return { ...unavailableModelEffort(), unsupportedModelIds: unsupportedModelIds(unsupportedModels) };
    }
    if (model === undefined || model.type !== "select" || model.values.length === 0) {
        return { ...unavailableModelEffort(), unsupportedModelIds: unsupportedModelIds(unsupportedModels) };
    }
    const inspectModel = async (modelValue: string): Promise<readonly SessionConfigOption[]> =>
        (
            await sessions.inspectAgentSettings({
                additionalDirectories: [],
                agent,
                cwd,
                model: modelValue,
                signal,
            })
        ).configOptions;
    const valuesByModel: Record<string, readonly SessionConfigOption["values"][number][]> = {};
    if (resolution === "complete") {
        const effort = effortOption(initialOptions);
        if (effort === undefined || effort.type !== "select" || effort.values.length < 2) {
            return {
                ...unavailableModelEffort(),
                unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            };
        }
        for (const value of model.values) {
            if (unsupportedModels.some((diagnostic) => diagnostic.requestedValue === value.value)) {
                continue;
            }
            try {
                const selectedEffort = effortOption(await inspectModel(value.value));
                valuesByModel[value.value] = selectedEffort?.type === "select" ? selectedEffort.values : [];
            } catch (cause) {
                signal.throwIfAborted();
                if (!isUnavailableModel(cause, model.id, value.value)) {
                    throw cause;
                }
                unsupportedModels.push(cause);
            }
        }
        return {
            effortSettingId: effort.id,
            modelSettingId: model.id,
            resolution: "complete",
            unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            valuesByModel,
        };
    }
    if (command.model !== undefined) {
        const modelUnsupported = unsupportedModels.some((diagnostic) => diagnostic.requestedValue === command.model);
        const selectedEffort = effortOption(selectedOptions);
        if (!modelUnsupported) {
            valuesByModel[command.model] = selectedEffort?.type === "select" ? selectedEffort.values : [];
        }
        return {
            effortSettingId: selectedEffort?.id ?? "",
            modelSettingId: model.id,
            resolution: "on_model_selection",
            unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            valuesByModel,
        };
    }
    // No model was named, so the Agent answered about its own default model — one
    // whose effort option an Agent may withhold. Resolve that model's capability
    // too, or a session that never switches models can never offer an effort.
    const defaultModel = model.type === "select" ? model.currentValue : "";
    const reportedEffort = effortOption(selectedOptions);
    let selectedEffort = reportedEffort;
    if (defaultModel.length > 0 && reportedEffort === undefined) {
        try {
            selectedEffort = effortOption(await inspectModel(defaultModel));
        } catch (cause) {
            signal.throwIfAborted();
            if (!isUnavailableModel(cause, model.id, defaultModel)) {
                throw cause;
            }
            unsupportedModels.push(cause);
        }
    }
    if (
        defaultModel.length > 0 &&
        !unsupportedModels.some((diagnostic) => diagnostic.requestedValue === defaultModel)
    ) {
        valuesByModel[defaultModel] = selectedEffort?.type === "select" ? selectedEffort.values : [];
    }
    return {
        effortSettingId: selectedEffort?.id ?? "",
        modelSettingId: model.id,
        resolution: "on_model_selection",
        unsupportedModelIds: unsupportedModelIds(unsupportedModels),
        valuesByModel,
    };
}

function settingsRevision(
    agent: LocalAgentDefinition,
    reportedAgentVersion: string,
    settings: readonly AgentSetting[],
    modelEffort: AgentModelEffort,
): string {
    // A dynamic effort lookup adds one model's settings and values to an
    // otherwise stable Agent capability document. It must not look like the
    // Agent's settings changed each time a caller switches models.
    const revisionModelEffort =
        modelEffort.resolution === AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE
            ? modelEffort
            : {
                  effortSettingId: "",
                  modelSettingId: modelEffort.modelSettingId,
                  resolution: modelEffort.resolution,
                  unsupportedModelIds: modelEffort.unsupportedModelIds,
                  valuesByModel: {},
              };
    return createHash("sha256")
        .update(
            JSON.stringify({
                adapterVersion: agent.adapterVersion,
                agentId: agent.id,
                agentVersion: agent.agentVersion,
                modelEffort: revisionModelEffort,
                reportedAgentVersion,
                settings,
            }),
        )
        .digest("hex");
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
                publisher.recordRuntime(command.sessionId, {
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
            // An inspection-only preparation has no Session on the Relay, so this readiness is a reply
            // rather than a record: committing it would be rejected as an unknown Session and quarantine
            // an event that can never be replayed. The direct send below still delivers it.
            if (command.transient !== true) {
                metrics.measureSync("readiness-commit", () => {
                    publisher.recordRuntime(command.sessionId, event);
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

async function executeSessionLiveHistoryLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryLoad>,
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
        const history = await sessions.loadSessionHistory({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        });
        signal.throwIfAborted();
        audit.record({
            commandId: command.requestId,
            event: "session_history_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            history,
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
            history: { status: "unavailable" },
            kind: "session.live-history.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
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
        publisher.recordRuntime(command.sessionId, {
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
        publisher.recordAttempt(command.sessionId, daemonActivity(command, activity), attemptId);
    });
    const text = new CoalescingTextPublisher(
        timer,
        (messageId, delta) => {
            publisher.recordAttempt(
                command.sessionId,
                {
                    commandId: command.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId,
                    sessionId: command.sessionId,
                    text: delta,
                },
                attemptId,
            );
        },
        AGENT_TEXT_COALESCING_MILLISECONDS,
        AGENT_TEXT_MAXIMUM_LENGTH,
    );
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
            if (command.disposition === SessionPromptDisposition.Steer) {
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
        outbox.transitionExecution(command.commandId, "running");
        publisher.recordAttempt(
            command.sessionId,
            {
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId,
                sessionId: command.sessionId,
            },
            attemptId,
        );
        activateAttempt();
        const attachments = await resolvePromptArtifacts(config, command, signal);
        let stopReason: string;
        if (command.disposition === SessionPromptDisposition.Steer) {
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
                disposition: command.disposition,
                images: attachments.images,
                onActivity: activities.record,
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
        activities.flush();
        publisher.recordAttempt(
            command.sessionId,
            {
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: command.sessionId,
                stopReason,
            },
            attemptId,
        );
        outbox.transitionExecution(command.commandId, stopReason === "cancelled" ? "cancelled" : "succeeded");
        audit.record({
            commandId: command.commandId,
            event: stopReason === "cancelled" ? "session_cancelled" : "session_completed",
            sessionId: command.sessionId,
        });
    } catch (error) {
        text.flush();
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

function agentForSessionConfiguration(
    agent: LocalAgentDefinition,
    selections: readonly SessionConfigurationSelection[],
): ReturnType<typeof applyAgentLaunchSettings> {
    try {
        return applyAgentLaunchSettings(agent, selections);
    } catch (error) {
        if (error instanceof Error) {
            throw invalidSessionConfiguration(error.message);
        }
        throw error;
    }
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

function sessionConfigurationSelectionIsAvailable(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): boolean {
    if (option.type !== selection.valueType) {
        return false;
    }
    if (option.type === "boolean") {
        return selection.value.length === 0;
    }
    return !selection.booleanValue && option.values.some((value) => value.value === selection.value);
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
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (selection.configId === "model" || option?.category === "model") {
        return 0;
    }
    if (selection.configId === "reasoning_effort" || option?.category === "thought_level") {
        return 1;
    }
    if (option?.category === "model_config") {
        return 2;
    }
    return 3;
}

function assertAppliedSessionConfiguration(
    options: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
): void {
    const selectionsById = new Map(selections.map((selection) => [selection.configId, selection]));
    for (const option of options) {
        const selection = selectionsById.get(option.id);
        if (selection === undefined || !sessionConfigurationSelectionIsAvailable(option, selection)) {
            continue;
        }
        if (!sessionConfigurationMatches(option, selection)) {
            throw invalidSessionConfiguration(`The Turn configuration does not match Agent setting ${option.id}`);
        }
    }
}

function unavailableSessionConfigurationCategory(selection: SessionConfigurationSelection): string {
    if (selection.configId === "model") {
        return "model";
    }
    if (selection.configId === "reasoning_effort") {
        return "thought_level";
    }
    return "unknown";
}

async function applySessionConfigurationSelection(
    sessions: AcpSessionManager,
    audit: AuditStore,
    options: readonly SessionConfigOption[],
    selection: SessionConfigurationSelection,
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    commandId: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (option === undefined) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            unavailableSessionConfigurationCategory(selection),
            "setting_unavailable",
        );
        return options;
    }
    if (option.type !== selection.valueType) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "setting_schema_mismatch",
        );
        return options;
    }
    if (
        (option.type === "boolean" && selection.value.length > 0) ||
        (option.type === "select" && selection.booleanValue)
    ) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "selection_schema_mismatch",
        );
        return options;
    }
    if (option.type === "select" && !option.values.some((value) => value.value === selection.value)) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "value_unavailable",
        );
        return options;
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
    audit: AuditStore,
    initialOptions: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    commandId: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<void> {
    let options = initialOptions;
    const orderedSelections = selections.toSorted((left, right) => {
        const priority =
            sessionConfigurationPriority(left, initialOptions) - sessionConfigurationPriority(right, initialOptions);
        return priority === 0 ? left.configId.localeCompare(right.configId) : priority;
    });
    for (const selection of orderedSelections) {
        options = await applySessionConfigurationSelection(
            sessions,
            audit,
            options,
            selection,
            agent,
            cwd,
            additionalDirectories,
            commandId,
            sessionId,
            signal,
        );
    }
    assertAppliedSessionConfiguration(options, selections);
}

function warnIgnoredSetting(
    audit: AuditStore,
    event: string,
    commandId: string,
    sessionId: string,
    agentId: string,
    selection: SessionConfigurationSelection,
    category: string,
    reason: string,
): void {
    const details: Readonly<Record<string, string>> = {
        agentId,
        category,
        configId: selection.configId,
        reason,
        requestedValue: selection.value,
    };
    audit.record({ commandId, details, event, sessionId });
    process.stderr.write(`Mobius daemon warning ${JSON.stringify({ commandId, event, sessionId, ...details })}\n`);
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
    readonly resolveAgentCatalogEnvironment?: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>;
}

// A refresh observes the machine through executable discovery, which depends on ambient state such
// as PATH and the managed state directory. An Agent that was verified a moment ago is therefore not
// necessarily uninstalled just because one discovery attempt failed to re-verify it. Keep the last
// verified definition while the exact executable it was verified against still exists unchanged on
// disk, so a transient probe failure cannot silently drop a working Agent. A genuine removal, or a
// replaced executable, stops satisfying that check and is still reflected in the catalog.
async function retainStillInstalledAgents(
    previous: readonly LocalAgentDefinition[],
    refreshed: readonly LocalAgentDefinition[],
    signal: AbortSignal,
): Promise<readonly LocalAgentDefinition[]> {
    const refreshedIdentifiers = new Set(refreshed.map((agent) => agent.id));
    const retained: LocalAgentDefinition[] = [];
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
                        if (agentSettingsDiscoveries.has(command.requestId) || existing !== undefined) {
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
                                    timer,
                                );
                                for (const diagnostic of result.unsupportedModels) {
                                    const details = agentSettingsFailureDetails(command.agentId, diagnostic);
                                    audit.record({
                                        commandId: command.requestId,
                                        details,
                                        event: "agent_settings_model_unsupported",
                                        sessionId: `agent-settings:${command.agentId}`,
                                    });
                                    process.stderr.write(
                                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_model_unsupported", requestId: command.requestId, ...details })}\n`,
                                    );
                                }
                                audit.record({
                                    commandId: command.requestId,
                                    details: {
                                        agentId: command.agentId,
                                        unsupportedModelCount: result.unsupportedModels.length.toString(),
                                    },
                                    event: "agent_settings_discovered",
                                    sessionId: `agent-settings:${command.agentId}`,
                                });
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, result.event);
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
                                audit.record({
                                    commandId: command.requestId,
                                    details,
                                    event: "agent_settings_discovery_failed",
                                    sessionId: `agent-settings:${command.agentId}`,
                                });
                                if (failure instanceof AcpConfigurationValueUnavailableError) {
                                    process.stderr.write(
                                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_discovery_failed", requestId: command.requestId, ...details })}\n`,
                                    );
                                }
                                if (socket.readyState === WebSocket.OPEN) {
                                    send(socket, {
                                        code: operationErrorCode(failure),
                                        kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                                        message: operationErrorMessage(failure),
                                        requestId: command.requestId,
                                    });
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
    const sessionStore = new SqliteAcpSessionStore(config.auditDatabasePath);
    const outbox = new SessionEventOutbox(config.auditDatabasePath);
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
    const sessions = new AcpSessionManager(new DaemonAcpObserver(recordSessionEvent), sessionStore);
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
        const reconnectCommand = `npx --yes @moxt-ai/mobius start ${config.reconnectTarget.commandArgument}`;
        process.stdout.write("Mobius daemon connected to the relay.\n\n");
        process.stdout.write(
            `${styleText(["bold", "yellow"], `Reconnect this local connection later:\n  ${reconnectCommand}`)}\n\n`,
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
                    announceConnection,
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
