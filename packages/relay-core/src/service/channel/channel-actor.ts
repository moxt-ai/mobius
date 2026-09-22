import {
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
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type DaemonToServiceMessage,
    decodeAgentCatalogRefreshCommand,
    decodeAgentInstallCancelCommand,
    decodeAgentInstallRequestCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionRequest,
    decodeNativeSessionTurnForkRequest,
    decodeServiceToDaemonMessage,
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionLiveHistoryLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeAgentCatalogRefreshFailedEvent,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeCommittedSessionEvent,
    encodeDaemonToServiceMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    encodeSessionFailedEvent,
    encodeSessionOperationFailedEvent,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    NATIVE_SESSION_TURN_FORK_REQUEST_KIND,
    type NativeSessionCommand,
    type NativeSessionHistory,
    type NativeSessionTurnForkCommand,
    type NativeSessionTurnForkRequest,
    ProtocolMessageError,
    type RecordedSessionEvent,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
    SESSION_LIVE_HISTORY_LOADED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_READY_KIND,
    type ServiceToDaemonMessage,
    type SessionEventEnvelope,
    type SessionEventRejection,
    SessionEventRejectionCode,
    type SessionPrepareCommand,
    validateSessionEventEnvelope,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import {
    CreateSessionBindingRequest,
    CreateSessionRequest,
    type ProjectScope,
    type SessionMessage,
    SessionRecordingPolicy,
    SessionRuntimeError,
} from "../../entity/do/session.ts";
import type { SessionCommandRuntime, SessionQueryRuntime } from "../../infra/session-runtime.ts";
import { sha256 } from "../do/session-archive-codec.ts";
import type { RuntimeConnectionService } from "./runtime-connection-service.ts";

const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MINIMUM_TRUNCATED_HISTORY_MATCH_CHARACTERS = 32;
const RUNTIME_DELIVERY_WINDOW = 16;
const RUNTIME_DELIVERY_BYTE_LIMIT = 16 * 1024 * 1024;
const SESSION_EVENT_BACKPRESSURE_RETRY_MILLISECONDS = 1_000;
const NATIVE_IMPORT_DEADLINE_MILLISECONDS = 5 * 60 * 1_000;
const nonRetainedNativeHistory = (): NativeSessionHistory => ({
    cause: {
        code: "native_history_not_retained",
        message: "Native message history is not retained in the cloud for this Session.",
    },
    status: "unavailable",
});
const MAX_PENDING_NATIVE_IMPORTS = 4;
const AGENT_SETTINGS_DISCOVERY_DEADLINE_MILLISECONDS = 2 * 60 * 1_000;
const AGENT_CATALOG_REFRESH_DEADLINE_MILLISECONDS = 2 * 60 * 1_000;

class PendingAgentSettingsDiscovery {
    readonly agentId: string;
    readonly expiresAt: number;
    readonly socket: ChannelSocket;

    constructor(agentId: string, expiresAt: number, socket: ChannelSocket) {
        this.agentId = agentId;
        this.expiresAt = expiresAt;
        this.socket = socket;
    }
}

class PendingAgentCatalogRefresh {
    readonly expiresAt: number;
    readonly socket: ChannelSocket;

    constructor(expiresAt: number, socket: ChannelSocket) {
        this.expiresAt = expiresAt;
        this.socket = socket;
    }
}

function reconcileNativeHistoryCoverage(
    history: NativeSessionHistory,
    messages: readonly SessionMessage[],
): NativeSessionHistory {
    if (history.status !== "available") {
        return history;
    }
    let historyIndex = history.messages.length;
    const coveredCommandIds: string[] = [];
    const coveredMessageIds: string[] = [];
    for (const message of messages) {
        let assistantStartIndex = historyIndex;
        while (assistantStartIndex > 0 && history.messages[assistantStartIndex - 1]?.role === "assistant") {
            assistantStartIndex -= 1;
        }
        if (assistantStartIndex === historyIndex) {
            break;
        }
        const assistantText = history.messages
            .slice(assistantStartIndex, historyIndex)
            .map((entry) => entry.text)
            .join("");
        const user = history.messages[assistantStartIndex - 1];
        if (
            user?.role === "user" &&
            user.text === message.prompt &&
            assistantText === message.response &&
            message.images.length === 0 &&
            message.resources.length === 0
        ) {
            coveredCommandIds.push(message.commandId);
            coveredMessageIds.push(`${message.commandId}:user`, `${message.commandId}:agent`);
            historyIndex = assistantStartIndex - 1;
            continue;
        }
        if (
            history.truncated &&
            assistantStartIndex === 0 &&
            assistantText.length >= MINIMUM_TRUNCATED_HISTORY_MATCH_CHARACTERS &&
            message.response.endsWith(assistantText)
        ) {
            coveredMessageIds.push(`${message.commandId}:agent`);
            historyIndex = 0;
            continue;
        }
        break;
    }
    return { ...history, coveredCommandIds, coveredMessageIds };
}

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1011 | 1013 {
    if (error.code === "session_busy" || error.code === "session_quota_exceeded") {
        return 1013;
    }
    if (error.code === "session_storage_timeout" || error.code === "session_storage_unavailable") {
        return 1011;
    }
    return 1008;
}

function isTerminalSessionEventError(error: SessionRuntimeError): boolean {
    return (
        error.code === "event_source_conflict" ||
        error.code === "session_access_denied" ||
        error.code === "session_conflict" ||
        error.code === "session_quota_exceeded"
    );
}

function isDeferredSessionEventError(error: SessionRuntimeError): boolean {
    return (
        error.code === "session_busy" ||
        error.code === "session_storage_timeout" ||
        error.code === "session_storage_unavailable"
    );
}

export interface RelayClock {
    readonly now: () => number;
}

export class SystemRelayClock implements RelayClock {
    readonly now = (): number => Date.now();
}

export interface ChannelSocket {
    readonly close: (code: number, reason: string) => void;
    readonly consumeAgentCatalogRefresh: (requestId: string, now: number) => boolean;
    readonly consumeAgentSettingsDiscovery: (requestId: string, agentId: string, now: number) => boolean;
    readonly consumeAgentSettingsDiscoveryFailure: (requestId: string, now: number) => boolean;
    readonly isOpen: () => boolean;
    readonly isSame: (socket: ChannelSocket) => boolean;
    readonly permitsLiveSessionHistory: () => boolean;
    readonly send: (message: string) => void;
    readonly trackAgentCatalogRefresh: (requestId: string, expiresAt: number) => void;
    readonly trackAgentSettingsDiscovery: (requestId: string, agentId: string, expiresAt: number) => void;
}

export interface ChannelPeers {
    readonly daemons: () => readonly ChannelSocket[];
    readonly hosts: () => readonly ChannelSocket[];
}

export class ChannelActor {
    readonly #pendingAgentCatalogRefreshes = new Map<string, PendingAgentCatalogRefresh>();
    readonly #pendingAgentSettingsDiscoveries = new Map<string, PendingAgentSettingsDiscovery>();
    readonly #pendingLiveSessionHistory = new Map<
        string,
        { readonly expiresAt: number; readonly socket: ChannelSocket }
    >();
    readonly #pendingNativeImports = new Map<
        string,
        | {
              readonly action: "import" | "fork";
              readonly cloudRetention: boolean;
              readonly request: CreateSessionRequest;
              readonly expiresAt: number;
              readonly scope: ProjectScope;
          }
        | {
              readonly action: "preview";
              readonly sessionId: string;
              readonly entryId: string;
              readonly expiresAt: number;
              readonly scope: ProjectScope;
          }
    >();
    readonly #backpressuredEventBySource = new Map<string, string>();
    readonly #clock: RelayClock;
    readonly #commands: SessionCommandRuntime;
    readonly #connections: Pick<RuntimeConnectionService, "clearActiveSession" | "current" | "recordActiveSession">;
    readonly #peers: ChannelPeers;
    readonly #queries: SessionQueryRuntime;
    readonly #runtimeId: string;
    readonly #scope: ProjectScope;
    readonly #inFlightDeliveries = new Map<string, number>();
    #inFlightDeliveryBytes = 0;
    #deliveryReceipts = false;
    #dispatchTail: Promise<void> = Promise.resolve();

    constructor(cx: {
        readonly config: { readonly runtimeId: string; readonly scope: ProjectScope };
        readonly connections: Pick<RuntimeConnectionService, "clearActiveSession" | "current" | "recordActiveSession">;
        readonly gateways: {
            readonly peers: ChannelPeers;
            readonly clock?: RelayClock;
        };
        readonly runtimes: { readonly commands: SessionCommandRuntime; readonly queries: SessionQueryRuntime };
    }) {
        const { runtimeId, scope } = cx.config;
        const { peers, clock = new SystemRelayClock() } = cx.gateways;
        const { commands, queries } = cx.runtimes;
        this.#clock = clock;
        this.#commands = commands;
        this.#connections = cx.connections;
        this.#peers = peers;
        this.#queries = queries;
        this.#runtimeId = runtimeId;
        this.#scope = scope;
    }

    readonly attachDaemon = async (replacedExistingConnection: boolean, signal: AbortSignal): Promise<void> => {
        this.#clearInFlightDeliveries();
        if (replacedExistingConnection) {
            this.failPendingAgentCatalogRefreshes();
            this.failPendingAgentSettingsDiscoveries();
            this.#pendingNativeImports.clear();
            await this.#commands.markRuntimeDisconnected(this.#scope, this.#runtimeId, this.#clock.now(), signal);
        }
        this.broadcastRuntimeStatus(true);
        await this.dispatchPending(signal);
    };

    readonly configureDaemonDelivery = (deliveryReceipts: boolean): void => {
        if (this.#deliveryReceipts === deliveryReceipts) {
            return;
        }
        this.#deliveryReceipts = deliveryReceipts;
        this.#clearInFlightDeliveries();
    };

    /**
     * Remember that this Runtime now has work for a Session.
     *
     * A Session holds its own Attempt state, so settling a Runtime disconnect means asking each affected
     * Session Durable Object to mark its in-flight Attempts indeterminate. Recording the Sessions the Relay
     * hands work to is what lets a disconnect settle only those Sessions instead of every ready Session in the
     * Project, so a Session whose Turn already finished is never revisited.
     */
    readonly recordActiveSession = (sessionId: string): void => {
        const current = this.#connections.current();
        if (current === null || current.runtimeId !== this.#runtimeId) {
            return;
        }
        this.#connections.recordActiveSession(this.#runtimeId, sessionId, current.connectionEpoch, this.#clock.now());
    };

    readonly clearActiveSession = (sessionId: string): void => {
        const current = this.#connections.current();
        if (current === null || current.runtimeId !== this.#runtimeId) {
            return;
        }
        this.#connections.clearActiveSession(this.#runtimeId, sessionId, current.connectionEpoch);
    };

    readonly attachHost = (socket: ChannelSocket, _signal: AbortSignal): Promise<void> => {
        socket.send(
            encodeRuntimeStatusEvent({
                kind: RUNTIME_STATUS_KIND,
                online: this.hasOnlineDaemon(),
                runtimeId: this.#runtimeId,
            }),
        );
        return Promise.resolve();
    };

    readonly detachDaemon = async (socket: ChannelSocket, signal: AbortSignal): Promise<void> => {
        const anotherDaemonOnline = this.#peers
            .daemons()
            .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
        if (anotherDaemonOnline) {
            return;
        }
        this.#backpressuredEventBySource.clear();
        this.failPendingAgentCatalogRefreshes();
        this.failPendingAgentSettingsDiscoveries();
        this.#pendingNativeImports.clear();
        await this.#commands.markRuntimeDisconnected(this.#scope, this.#runtimeId, this.#clock.now(), signal);
        this.broadcastRuntimeStatus(false);
    };

    readonly receiveDaemonMessage = async (
        socket: ChannelSocket,
        message: DaemonToServiceMessage,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            const kind = message.kind;
            if (kind === RUNTIME_DELIVERY_RECEIVED_KIND) {
                if (!this.#deliveryReceipts) {
                    throw new ProtocolMessageError("Runtime delivery receipts were not negotiated");
                }
                const receipt = message;
                try {
                    await this.#commands.markPendingWorkCompleted(
                        this.#scope,
                        receipt.sessionId,
                        receipt.deliveryId,
                        this.#clock.now(),
                        signal,
                    );
                } catch (error) {
                    if (
                        !(error instanceof SessionRuntimeError) ||
                        (error.code !== "pending_work_not_found" &&
                            error.code !== "session_not_found" &&
                            error.code !== "session_deleted")
                    ) {
                        throw error;
                    }
                }
                this.#removeInFlightDelivery(receipt.deliveryId);
                socket.send(
                    encodeServiceToDaemonMessage({
                        deliveryId: receipt.deliveryId,
                        kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                        sessionId: receipt.sessionId,
                    }),
                );
                await this.dispatchPending(signal);
                return;
            }
            if (kind === SESSION_EVENT_KIND) {
                const envelope = message;
                const sourceKey = this.sessionEventSourceKey(envelope);
                const backpressuredEventId = this.#backpressuredEventBySource.get(sourceKey);
                if (backpressuredEventId !== undefined && backpressuredEventId !== envelope.eventId) {
                    this.deferSessionEvent(socket, envelope);
                    return;
                }
                const event = validateSessionEventEnvelope(envelope);
                let result: Awaited<ReturnType<SessionCommandRuntime["commitEvent"]>>;
                try {
                    result = await this.#commands.commitEvent(
                        this.#scope,
                        this.#runtimeId,
                        envelope,
                        this.#clock.now(),
                        signal,
                    );
                } catch (error) {
                    if (!signal.aborted && error instanceof SessionRuntimeError && isDeferredSessionEventError(error)) {
                        this.#backpressuredEventBySource.set(sourceKey, envelope.eventId);
                        this.deferSessionEvent(socket, envelope);
                        return;
                    }
                    if (backpressuredEventId === envelope.eventId) {
                        this.#backpressuredEventBySource.delete(sourceKey);
                    }
                    if (!signal.aborted && error instanceof SessionRuntimeError && error.code === "session_deleted") {
                        this.rejectSessionEvent(socket, envelope, event, SessionEventRejectionCode.SessionDeleted);
                        return;
                    }
                    if (!signal.aborted && error instanceof SessionRuntimeError && error.code === "session_not_found") {
                        if (this.hasPendingNativeSessionRegistration(envelope.sessionId)) {
                            this.#backpressuredEventBySource.set(sourceKey, envelope.eventId);
                            this.deferSessionEvent(socket, envelope);
                            return;
                        }
                        this.rejectSessionEvent(socket, envelope, event, SessionEventRejectionCode.SessionNotFound);
                        return;
                    }
                    if (!signal.aborted && error instanceof SessionRuntimeError && isTerminalSessionEventError(error)) {
                        this.rejectSessionEvent(socket, envelope, event, SessionEventRejectionCode.SessionRejected);
                        return;
                    }
                    throw error;
                }
                if (backpressuredEventId === envelope.eventId) {
                    this.#backpressuredEventBySource.delete(sourceKey);
                }
                socket.send(
                    encodeServiceToDaemonMessage({
                        cursor: result.committed.cursor,
                        duplicate: result.duplicate,
                        eventId: result.committed.eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                        sequence: result.committed.sequence,
                        sessionId: result.committed.sessionId,
                    }),
                );
                if (!result.duplicate) {
                    this.broadcast(this.#peers.hosts(), encodeCommittedSessionEvent(result.committed));
                }
                if (
                    !result.duplicate &&
                    (decodeMessageKind(envelope.payload) === "session.completed" ||
                        decodeMessageKind(envelope.payload) === "session.failed")
                ) {
                    // The Turn reached a terminal outcome, so this Session no longer holds Runtime work.
                    this.clearActiveSession(envelope.sessionId);
                    await this.dispatchPending(signal);
                }
                return;
            }
            if (kind === NATIVE_SESSION_RESULT_KIND) {
                const result = message;
                let forwardedMessage: DaemonToServiceMessage = message;
                if (result.action === "import" || result.action === "fork") {
                    const pending = this.#pendingNativeImports.get(result.requestId);
                    if (
                        pending === undefined ||
                        pending.expiresAt <= this.#clock.now() ||
                        pending.action === "preview" ||
                        pending.action !== result.action ||
                        pending.request.sessionId !== result.targetSessionId ||
                        pending.request.agentId !== result.ready.agentId
                    ) {
                        throw new ProtocolMessageError("The native session result does not match a pending import");
                    }
                    await this.#commands.createSession(
                        pending.scope,
                        pending.request,
                        pending.cloudRetention,
                        this.#clock.now(),
                        signal,
                    );
                    const target = await this.#queries.readSession(pending.scope, result.targetSessionId, signal);
                    if (
                        target.runtimeId !== this.#runtimeId ||
                        target.agentId !== result.ready.agentId ||
                        target.defaultBinding.workspaceRef !== result.ready.directoryId
                    ) {
                        throw new ProtocolMessageError("The native session result resolved to a different binding");
                    }
                    if (result.ready.sessionId !== result.targetSessionId) {
                        const existing = await this.#queries.readSession(pending.scope, result.ready.sessionId, signal);
                        if (existing.runtimeId !== this.#runtimeId || existing.agentId !== result.ready.agentId) {
                            throw new ProtocolMessageError("The native session result resolved to a different binding");
                        }
                        await this.#commands.deleteSession(
                            pending.scope,
                            result.targetSessionId,
                            this.#clock.now(),
                            signal,
                        );
                    }
                    if (!pending.cloudRetention) {
                        forwardedMessage = {
                            ...result,
                            history: nonRetainedNativeHistory(),
                        };
                    } else {
                        const messages = await this.#queries.readMessages(
                            pending.scope,
                            result.ready.sessionId,
                            null,
                            100,
                            signal,
                        );
                        const history = reconcileNativeHistoryCoverage(result.history, messages.messages);
                        await this.#commands.recordNativeHistory(
                            pending.scope,
                            this.#runtimeId,
                            result.ready.sessionId,
                            result.title,
                            history,
                            this.#clock.now(),
                            signal,
                        );
                        forwardedMessage = { ...result, history };
                    }
                } else if (result.action === "preview") {
                    const pending = this.#pendingNativeImports.get(result.requestId);
                    if (
                        pending === undefined ||
                        pending.expiresAt <= this.#clock.now() ||
                        (pending.action === "preview"
                            ? result.reason !== "requested" ||
                              pending.sessionId !== result.sessionId ||
                              pending.sessionId !== result.targetSessionId ||
                              pending.entryId !== result.entryId
                            : result.reason !== "continuation_unavailable" ||
                              pending.request.sessionId !== result.targetSessionId)
                    ) {
                        throw new ProtocolMessageError("The native preview does not match a pending import");
                    }
                }
                this.broadcast(this.#peers.hosts(), encodeDaemonToServiceMessage(forwardedMessage));
                this.#pendingNativeImports.delete(result.requestId);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERED_KIND) {
                this.returnAgentSettingsDiscoveryResult(
                    message.requestId,
                    message.agentId,
                    encodeDaemonToServiceMessage(message),
                );
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERY_FAILED_KIND) {
                this.returnAgentSettingsDiscoveryFailure(message.requestId, encodeDaemonToServiceMessage(message));
                return;
            }
            if (kind === AGENT_CATALOG_REFRESHED_KIND) {
                this.returnAgentCatalogRefreshResult(message.requestId, encodeDaemonToServiceMessage(message));
                return;
            }
            if (kind === AGENT_CATALOG_REFRESH_FAILED_KIND) {
                this.returnAgentCatalogRefreshResult(message.requestId, encodeDaemonToServiceMessage(message));
                return;
            }
            if (kind === SESSION_LIVE_HISTORY_LOADED_KIND) {
                const result = message;
                const pending = this.#pendingLiveSessionHistory.get(result.requestId);
                if (pending === undefined || pending.expiresAt <= this.#clock.now()) {
                    throw new ProtocolMessageError("The live Session history response is not pending");
                }
                pending.socket.send(encodeDaemonToServiceMessage(message));
                this.#pendingLiveSessionHistory.delete(result.requestId);
                return;
            }
            if (kind === SESSION_OPERATION_FAILED_KIND) {
                this.#pendingNativeImports.delete(message.requestId);
            }
            this.validateDaemonControl(message);
            this.broadcast(this.#peers.hosts(), encodeDaemonToServiceMessage(message));
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(
                error instanceof ProtocolMessageError ? 1008 : 1011,
                error instanceof ProtocolMessageError ? "Invalid protocol message" : "Session storage unavailable",
            );
        }
    };

    private readonly deferSessionEvent = (socket: ChannelSocket, envelope: SessionEventEnvelope): void => {
        socket.send(
            encodeServiceToDaemonMessage({
                eventId: envelope.eventId,
                kind: SESSION_EVENT_DEFERRED_KIND,
                retryAfterMilliseconds: SESSION_EVENT_BACKPRESSURE_RETRY_MILLISECONDS,
                sessionId: envelope.sessionId,
            }),
        );
    };

    private readonly sessionEventSourceKey = (envelope: SessionEventEnvelope): string =>
        envelope.source.kind === "attempt"
            ? `attempt:${envelope.sessionId}:${envelope.source.attemptId}`
            : `runtime:${envelope.sessionId}`;

    private readonly rejectSessionEvent = (
        socket: ChannelSocket,
        envelope: SessionEventEnvelope,
        event: RecordedSessionEvent,
        code: SessionEventRejection["code"],
    ): void => {
        socket.send(
            encodeServiceToDaemonMessage({
                code,
                eventId: envelope.eventId,
                kind: SESSION_EVENT_REJECTED_KIND,
                sessionId: envelope.sessionId,
            }),
        );
        if ("commandId" in event) {
            this.broadcast(
                this.#peers.hosts(),
                encodeSessionFailedEvent({
                    code: "session_event_rejected",
                    commandId: event.commandId,
                    kind: SESSION_FAILED_KIND,
                    message: "The Runtime response was rejected by the Session",
                    sessionId: envelope.sessionId,
                }),
            );
        }
    };

    readonly receiveHostMessage = async (
        scope: ProjectScope,
        cloudRetention: boolean,
        socket: ChannelSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        try {
            const kind = decodeMessageKind(message);
            if (kind === SESSION_PROMPT_KIND) {
                const command = decodeSessionPromptCommand(message);
                if (!this.hasOnlineDaemon()) {
                    socket.send(
                        encodeSessionFailedEvent({
                            code: "runtime_offline",
                            commandId: command.commandId,
                            kind: SESSION_FAILED_KIND,
                            message: "The local runtime is offline; the command was not accepted",
                            sessionId: command.sessionId,
                        }),
                    );
                    return;
                }
                let acceptance: Awaited<ReturnType<SessionCommandRuntime["acceptTurn"]>>;
                try {
                    acceptance = await this.#commands.acceptTurn(
                        scope,
                        this.#runtimeId,
                        command,
                        this.#clock.now(),
                        signal,
                    );
                } catch (error) {
                    if (error instanceof SessionRuntimeError) {
                        socket.send(
                            encodeSessionFailedEvent({
                                code: error.code,
                                commandId: command.commandId,
                                kind: SESSION_FAILED_KIND,
                                message: error.message,
                                sessionId: command.sessionId,
                            }),
                        );
                        return;
                    }
                    throw error;
                }
                if (acceptance.kind === "duplicate") {
                    socket.send(
                        encodeSessionFailedEvent({
                            code: `duplicate_${acceptance.state}`,
                            commandId: command.commandId,
                            kind: SESSION_FAILED_KIND,
                            message: "The command was already accepted and was not executed again",
                            sessionId: command.sessionId,
                        }),
                    );
                    return;
                }
                await this.dispatchPending(signal);
                this.broadcast(this.#peers.hosts(), message);
                return;
            }
            if (kind === SESSION_PREPARE_KIND) {
                const command = decodeSessionPrepareCommand(message);
                if (command.transient === true) {
                    this.forwardControl(socket, command, command.requestId, command.sessionId);
                    return;
                }
                const now = this.#clock.now();
                if (command.sessionState === "provisioned") {
                    await this.reconcilePreparedSession(scope, command, now, signal);
                    const { sessionState, ...daemonCommand } = command;
                    void sessionState;
                    this.forwardControl(socket, daemonCommand, command.requestId, command.sessionId);
                    return;
                }
                try {
                    await this.#commands.createSession(
                        scope,
                        new CreateSessionRequest(
                            command.sessionId,
                            this.#runtimeId,
                            command.agentId,
                            command.bindingId,
                            command.directoryId,
                            new SessionRecordingPolicy("full", DEFAULT_RETENTION_MILLISECONDS, 1_000, 6_000_000),
                        ),
                        cloudRetention,
                        now,
                        signal,
                    );
                } catch (error) {
                    if (!(error instanceof SessionRuntimeError) || error.code !== "session_conflict") {
                        throw error;
                    }
                    await this.reconcilePreparedSession(scope, command, now, signal);
                }
                this.forwardControl(socket, command, command.requestId, command.sessionId);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
                const command = decodeAgentSettingsDiscoverCommand(message);
                this.forwardAgentSettingsDiscovery(socket, command, command.requestId, command.agentId);
                return;
            }
            if (kind === AGENT_CATALOG_REFRESH_KIND) {
                const command = decodeAgentCatalogRefreshCommand(message);
                this.forwardAgentCatalogRefresh(socket, command, command.requestId);
                return;
            }
            if (kind === NATIVE_SESSION_REQUEST_KIND) {
                const request = decodeNativeSessionRequest(message);
                const command: NativeSessionCommand =
                    !cloudRetention && (request.action === "import" || request.action === "fork")
                        ? { ...request, action: request.action === "import" ? "import-only" : "fork-only" }
                        : decodeNativeSessionCommand(message);
                if (command.action === "preview") {
                    const now = this.#clock.now();
                    this.expireNativeImports(now);
                    if (
                        this.#pendingNativeImports.has(request.requestId) ||
                        this.#pendingNativeImports.size >= MAX_PENDING_NATIVE_IMPORTS
                    ) {
                        throw new ProtocolMessageError("Another native session operation is pending");
                    }
                    if (this.hasOnlineDaemon()) {
                        this.#pendingNativeImports.set(request.requestId, {
                            action: "preview",
                            sessionId: command.sessionId,
                            entryId: command.entryId,
                            expiresAt: now + NATIVE_IMPORT_DEADLINE_MILLISECONDS,
                            scope,
                        });
                    }
                }
                if (request.action === "import" || request.action === "fork") {
                    const now = this.#clock.now();
                    this.expireNativeImports(now);
                    if (
                        this.#pendingNativeImports.has(command.requestId) ||
                        this.#pendingNativeImports.size >= MAX_PENDING_NATIVE_IMPORTS
                    ) {
                        throw new ProtocolMessageError("Another native session import is pending");
                    }
                    if (this.hasOnlineDaemon()) {
                        this.#pendingNativeImports.set(command.requestId, {
                            action: request.action,
                            cloudRetention,
                            request: new CreateSessionRequest(
                                request.targetSessionId,
                                this.#runtimeId,
                                request.agentId,
                                request.bindingId,
                                request.directoryId,
                                new SessionRecordingPolicy("full", DEFAULT_RETENTION_MILLISECONDS, 1_000, 6_000_000),
                            ),
                            expiresAt: now + NATIVE_IMPORT_DEADLINE_MILLISECONDS,
                            scope,
                        });
                    }
                }
                this.forwardControl(socket, command, request.requestId, request.sessionId, request);
                return;
            }
            if (kind === NATIVE_SESSION_TURN_FORK_REQUEST_KIND) {
                const command = decodeNativeSessionTurnForkRequest(message);
                try {
                    if (!this.hasOnlineDaemon()) {
                        throw new SessionRuntimeError("runtime_offline", "The local runtime is offline");
                    }
                    const source = await this.#queries.readSession(scope, command.sessionId, signal);
                    if (
                        source.runtimeId !== this.#runtimeId ||
                        source.agentId !== command.agentId ||
                        source.defaultBinding.bindingId !== command.bindingId ||
                        source.defaultBinding.workspaceRef !== command.directoryId
                    ) {
                        throw new SessionRuntimeError(
                            "session_binding_mismatch",
                            "The source Session binding changed before it could be forked",
                        );
                    }
                    const authorized = await this.resolveTurnForkCommand(scope, command, signal);
                    this.expireNativeImports(this.#clock.now());
                    if (
                        this.#pendingNativeImports.has(command.requestId) ||
                        this.#pendingNativeImports.size >= MAX_PENDING_NATIVE_IMPORTS
                    ) {
                        throw new ProtocolMessageError("Another native session import is pending");
                    }
                    this.#pendingNativeImports.set(command.requestId, {
                        action: "fork",
                        cloudRetention,
                        request: new CreateSessionRequest(
                            command.targetSessionId,
                            this.#runtimeId,
                            command.agentId,
                            command.bindingId,
                            command.directoryId,
                            new SessionRecordingPolicy(
                                source.policy.level,
                                source.policy.retentionMilliseconds,
                                source.policy.hotEventLimit,
                                source.policy.contentLimitBytes,
                                source.policy.idempotencyRetentionMilliseconds,
                            ),
                            source.title,
                        ),
                        expiresAt: this.#clock.now() + NATIVE_IMPORT_DEADLINE_MILLISECONDS,
                        scope,
                    });
                    if (!this.sendToDaemon(authorized)) {
                        this.#pendingNativeImports.delete(command.requestId);
                        throw new SessionRuntimeError("runtime_offline", "The local runtime went offline");
                    }
                } catch (error) {
                    if (!(error instanceof SessionRuntimeError)) {
                        throw error;
                    }
                    socket.send(
                        encodeSessionOperationFailedEvent({
                            code: error.code,
                            kind: SESSION_OPERATION_FAILED_KIND,
                            message: error.message,
                            requestId: command.requestId,
                            sessionId: command.sessionId,
                        }),
                    );
                }
                return;
            }
            if (kind === SESSION_LIVE_HISTORY_LOAD_KIND) {
                if (!socket.permitsLiveSessionHistory()) {
                    throw new ProtocolMessageError("Live Session history requires an internal connection");
                }
                const command = decodeSessionLiveHistoryLoad(message);
                const now = this.#clock.now();
                for (const [requestId, pending] of this.#pendingLiveSessionHistory) {
                    if (pending.expiresAt <= now) {
                        this.#pendingLiveSessionHistory.delete(requestId);
                    }
                }
                if (
                    this.#pendingLiveSessionHistory.has(command.requestId) ||
                    this.#pendingLiveSessionHistory.size >= 16
                ) {
                    throw new ProtocolMessageError("Too many live Session history operations are pending");
                }
                this.#pendingLiveSessionHistory.set(command.requestId, { expiresAt: now + 30_000, socket });
                if (!this.sendToDaemon(command)) {
                    this.#pendingLiveSessionHistory.delete(command.requestId);
                    socket.close(1013, "Runtime offline");
                    return;
                }
                return;
            }
            if (kind === SESSION_PERMISSION_RESPOND_KIND) {
                const command = decodeSessionPermissionRespondCommand(message);
                try {
                    await this.acceptAndDeliverInteractionResponse(
                        scope,
                        command.sessionId,
                        command.interactionId,
                        {
                            content: JSON.stringify({
                                optionId: command.optionId,
                                outcome: command.outcome,
                            }),
                            kind: "permission",
                        },
                        message,
                        signal,
                    );
                } catch (error) {
                    if (this.sendInteractionFailure(socket, command.sessionId, command.interactionId, error)) {
                        return;
                    }
                    throw error;
                }
                this.broadcast(this.#peers.hosts(), message);
                return;
            }
            if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                const command = decodeSessionElicitationRespondCommand(message);
                try {
                    await this.acceptAndDeliverInteractionResponse(
                        scope,
                        command.sessionId,
                        command.interactionId,
                        {
                            content: JSON.stringify({
                                action: command.action,
                                content: command.content,
                            }),
                            kind: "elicitation",
                        },
                        message,
                        signal,
                    );
                } catch (error) {
                    if (this.sendInteractionFailure(socket, command.sessionId, command.interactionId, error)) {
                        return;
                    }
                    throw error;
                }
                this.broadcast(this.#peers.hosts(), message);
                return;
            }
            const control = this.validateHostControl(kind, message);
            this.forwardControl(socket, control.message, control.requestId, control.sessionId);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(1008, "Invalid protocol message");
        }
    };

    private readonly validateDaemonControl = (message: DaemonToServiceMessage): void => {
        switch (message.kind) {
            case AGENT_CATALOG_REFRESHED_KIND:
                return;
            case AGENT_CATALOG_REFRESH_FAILED_KIND:
                return;
            case AGENT_SETTINGS_DISCOVERED_KIND:
                return;
            case AGENT_SETTINGS_DISCOVERY_FAILED_KIND:
                return;
            case FILE_BEGIN_KIND:
                return;
            case FILE_CHUNK_KIND:
                return;
            case FILE_END_KIND:
                return;
            case FILE_FAILED_KIND:
                return;
            case NATIVE_SESSION_RESULT_KIND:
                return;
            case WORKSPACE_ENTRIES_KIND:
                return;
            case SESSION_OPERATION_FAILED_KIND:
                return;
            case SESSION_READY_KIND:
                return;
            case AGENT_INSTALL_STARTED_KIND:
                return;
            case AGENT_INSTALL_PROGRESS_KIND:
                return;
            case AGENT_INSTALL_COMPLETED_KIND:
                return;
            case AGENT_INSTALL_FAILED_KIND:
                return;
            case AGENT_INSTALL_CANCELLED_KIND:
                return;
            default:
                throw new ProtocolMessageError("Unsupported daemon message");
        }
    };

    private readonly resolveTurnForkCommand = async (
        scope: ProjectScope,
        command: NativeSessionTurnForkRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionTurnForkCommand> => {
        const source = await this.#queries.readSession(scope, command.sessionId, signal);
        let cursor: Parameters<SessionQueryRuntime["readMessages"]>[2] = null;
        let found = false;
        let messageId = "";
        let response = "";
        let occurrence = 0;
        do {
            const page = await this.#queries.readMessages(scope, command.sessionId, cursor, 100, signal);
            for (const message of page.messages) {
                if (!found && message.commandId === command.sourceCommandId) {
                    if (
                        message.disposition === "steer" ||
                        (message.attempt?.kind !== "succeeded" && message.attempt?.kind !== "cancelled")
                    ) {
                        throw new SessionRuntimeError(
                            "fork_point_unavailable",
                            "Only a completed Agent turn can be used as a fork point",
                        );
                    }
                    found = true;
                    messageId = message.messageId;
                    response = message.response;
                    occurrence = 1;
                    continue;
                }
                if (found && message.response === response && message.disposition !== "steer") {
                    occurrence += 1;
                }
            }
            cursor = page.nextCursor;
        } while (cursor !== null);
        if (!found) {
            throw new SessionRuntimeError("fork_point_not_found", "The selected fork point does not exist");
        }
        return {
            ...command,
            kind: "native.session.turn-fork",
            messageFingerprint: `sha256:${await sha256(new TextEncoder().encode(response))}`,
            messageId: messageId.length > 0 ? messageId : `mobius-${command.sourceCommandId}`,
            messageOccurrence: occurrence,
            title: source.title,
        };
    };

    private readonly validateHostControl = (
        kind: string,
        message: string,
    ): {
        readonly message: ServiceToDaemonMessage;
        readonly requestId: string;
        readonly sessionId: string;
    } => {
        switch (kind) {
            case NATIVE_SESSION_REQUEST_KIND: {
                // Native session requests are fully handled before this validator runs;
                // reaching it means the request skipped Relay-side retention authorization.
                throw new ProtocolMessageError("Native session requests require retention authorization");
            }
            case NATIVE_SESSION_CANCEL_KIND: {
                const command = decodeNativeSessionCancel(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_CANCEL_KIND: {
                const command = decodeSessionCancelCommand(message);
                return { message: command, requestId: command.commandId, sessionId: command.sessionId };
            }
            case WORKSPACE_LIST_KIND: {
                const command = decodeWorkspaceListCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case SESSION_CONFIGURE_KIND: {
                const command = decodeSessionConfigureCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_PERMISSION_RESPOND_KIND: {
                const command = decodeSessionPermissionRespondCommand(message);
                return {
                    message: command,
                    requestId: command.interactionId,
                    sessionId: command.sessionId,
                };
            }
            case SESSION_ELICITATION_RESPOND_KIND: {
                const command = decodeSessionElicitationRespondCommand(message);
                return {
                    message: command,
                    requestId: command.interactionId,
                    sessionId: command.sessionId,
                };
            }
            case AGENT_INSTALL_REQUEST_KIND: {
                const command = decodeAgentInstallRequestCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case AGENT_INSTALL_CANCEL_KIND: {
                const command = decodeAgentInstallCancelCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case FILE_READ_KIND: {
                const command = decodeFileReadCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            default:
                throw new ProtocolMessageError("Unsupported host message");
        }
    };

    private readonly reconcilePreparedSession = async (
        scope: ProjectScope,
        command: SessionPrepareCommand,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const existing = await this.#queries.readSession(scope, command.sessionId, signal);
        if (
            existing.defaultBinding.bindingId !== command.bindingId ||
            existing.defaultBinding.runtimeId !== this.#runtimeId ||
            existing.defaultBinding.agentRef !== command.agentId ||
            existing.defaultBinding.workspaceRef !== command.directoryId
        ) {
            await this.#commands.setDefaultBinding(
                scope,
                command.sessionId,
                new CreateSessionBindingRequest(
                    command.bindingId,
                    this.#runtimeId,
                    command.agentId,
                    command.directoryId,
                ),
                now,
                signal,
            );
        }
    };

    private readonly expireNativeImports = (now: number): void => {
        for (const [requestId, pending] of this.#pendingNativeImports) {
            if (pending.expiresAt <= now) {
                this.#pendingNativeImports.delete(requestId);
            }
        }
    };

    private readonly hasPendingNativeSessionRegistration = (sessionId: string): boolean => {
        for (const pending of this.#pendingNativeImports.values()) {
            if (pending.action !== "preview" && pending.request.sessionId === sessionId) {
                return true;
            }
        }
        return false;
    };

    private readonly forwardControl = (
        socket: ChannelSocket,
        message: ServiceToDaemonMessage,
        requestId: string,
        sessionId: string,
        broadcastMessage: ServiceToDaemonMessage = message,
    ): void => {
        if (!this.sendToDaemon(message)) {
            socket.send(
                encodeSessionFailedEvent({
                    code: "runtime_offline",
                    commandId: requestId,
                    kind: SESSION_FAILED_KIND,
                    message: "The local runtime is offline",
                    sessionId: sessionId.length === 0 ? "runtime" : sessionId,
                }),
            );
            return;
        }
        this.broadcast(this.#peers.hosts(), encodeServiceToDaemonMessage(broadcastMessage));
    };

    private readonly forwardAgentCatalogRefresh = (
        socket: ChannelSocket,
        message: ServiceToDaemonMessage,
        requestId: string,
    ): void => {
        const now = this.#clock.now();
        const expiresAt = now + AGENT_CATALOG_REFRESH_DEADLINE_MILLISECONDS;
        this.expireAgentCatalogRefreshes(now);
        if (this.#pendingAgentCatalogRefreshes.has(requestId)) {
            throw new ProtocolMessageError("Another local Agent catalog refresh is pending");
        }
        socket.trackAgentCatalogRefresh(requestId, expiresAt);
        this.#pendingAgentCatalogRefreshes.set(requestId, new PendingAgentCatalogRefresh(expiresAt, socket));
        if (!this.sendToDaemon(message)) {
            this.#pendingAgentCatalogRefreshes.delete(requestId);
            socket.consumeAgentCatalogRefresh(requestId, now);
            socket.send(
                encodeAgentCatalogRefreshFailedEvent({
                    code: "runtime_offline",
                    kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                    message: "The local runtime is offline",
                    requestId,
                }),
            );
        }
    };

    private readonly returnAgentCatalogRefreshResult = (requestId: string, message: string): void => {
        const now = this.#clock.now();
        this.expireAgentCatalogRefreshes(now);
        const pending = this.#pendingAgentCatalogRefreshes.get(requestId);
        if (pending !== undefined) {
            this.#pendingAgentCatalogRefreshes.delete(requestId);
            pending.socket.consumeAgentCatalogRefresh(requestId, now);
            this.sendAgentCatalogRefreshResult(pending, message);
            return;
        }
        const recipient = this.#peers.hosts().find((socket) => socket.consumeAgentCatalogRefresh(requestId, now));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly sendAgentCatalogRefreshResult = (pending: PendingAgentCatalogRefresh, message: string): void => {
        if (pending.socket.isOpen()) {
            pending.socket.send(message);
        }
    };

    private readonly expireAgentCatalogRefreshes = (now: number): void => {
        for (const [requestId, pending] of this.#pendingAgentCatalogRefreshes) {
            if (pending.expiresAt <= now) {
                this.#pendingAgentCatalogRefreshes.delete(requestId);
                pending.socket.consumeAgentCatalogRefresh(requestId, now);
            }
        }
    };

    private readonly failPendingAgentCatalogRefreshes = (): void => {
        const now = this.#clock.now();
        for (const [requestId, pending] of this.#pendingAgentCatalogRefreshes) {
            pending.socket.consumeAgentCatalogRefresh(requestId, now);
            if (pending.socket.isOpen()) {
                pending.socket.send(
                    encodeAgentCatalogRefreshFailedEvent({
                        code: "runtime_offline",
                        kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                        message: "The local runtime is offline",
                        requestId,
                    }),
                );
            }
        }
        this.#pendingAgentCatalogRefreshes.clear();
    };

    private readonly forwardAgentSettingsDiscovery = (
        socket: ChannelSocket,
        message: ServiceToDaemonMessage,
        requestId: string,
        agentId: string,
    ): void => {
        const now = this.#clock.now();
        const expiresAt = now + AGENT_SETTINGS_DISCOVERY_DEADLINE_MILLISECONDS;
        this.expireAgentSettingsDiscoveries(now);
        if (this.#pendingAgentSettingsDiscoveries.has(requestId)) {
            throw new ProtocolMessageError("Another Agent settings discovery is pending");
        }
        socket.trackAgentSettingsDiscovery(requestId, agentId, expiresAt);
        this.#pendingAgentSettingsDiscoveries.set(
            requestId,
            new PendingAgentSettingsDiscovery(agentId, expiresAt, socket),
        );
        if (!this.sendToDaemon(message)) {
            this.#pendingAgentSettingsDiscoveries.delete(requestId);
            socket.consumeAgentSettingsDiscoveryFailure(requestId, now);
            socket.send(
                encodeAgentSettingsDiscoveryFailedEvent({
                    code: "runtime_offline",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "The local runtime is offline",
                    requestId,
                }),
            );
            return;
        }
    };

    private readonly returnAgentSettingsDiscoveryResult = (
        requestId: string,
        agentId: string,
        message: string,
    ): void => {
        const now = this.#clock.now();
        this.expireAgentSettingsDiscoveries(now);
        const pending = this.#pendingAgentSettingsDiscoveries.get(requestId);
        if (pending !== undefined) {
            this.#pendingAgentSettingsDiscoveries.delete(requestId);
            if (pending.agentId !== agentId) {
                throw new ProtocolMessageError(
                    "The Agent settings discovery result does not match the requested Agent",
                );
            }
            pending.socket.consumeAgentSettingsDiscovery(requestId, agentId, now);
            this.sendAgentSettingsDiscoveryResult(pending, message);
            return;
        }
        const recipient = this.#peers
            .hosts()
            .find((socket) => socket.consumeAgentSettingsDiscovery(requestId, agentId, now));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnAgentSettingsDiscoveryFailure = (requestId: string, message: string): void => {
        const now = this.#clock.now();
        this.expireAgentSettingsDiscoveries(now);
        const pending = this.#pendingAgentSettingsDiscoveries.get(requestId);
        if (pending !== undefined) {
            this.#pendingAgentSettingsDiscoveries.delete(requestId);
            pending.socket.consumeAgentSettingsDiscoveryFailure(requestId, now);
            this.sendAgentSettingsDiscoveryResult(pending, message);
            return;
        }
        const recipient = this.#peers
            .hosts()
            .find((socket) => socket.consumeAgentSettingsDiscoveryFailure(requestId, now));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly sendAgentSettingsDiscoveryResult = (
        pending: PendingAgentSettingsDiscovery,
        message: string,
    ): void => {
        if (pending.socket.isOpen()) {
            pending.socket.send(message);
        }
    };

    private readonly expireAgentSettingsDiscoveries = (now: number): void => {
        for (const [requestId, pending] of this.#pendingAgentSettingsDiscoveries) {
            if (pending.expiresAt <= now) {
                this.#pendingAgentSettingsDiscoveries.delete(requestId);
                pending.socket.consumeAgentSettingsDiscoveryFailure(requestId, now);
            }
        }
    };

    private readonly failPendingAgentSettingsDiscoveries = (): void => {
        const now = this.#clock.now();
        for (const [requestId, pending] of this.#pendingAgentSettingsDiscoveries) {
            pending.socket.consumeAgentSettingsDiscoveryFailure(requestId, now);
            if (pending.socket.isOpen()) {
                pending.socket.send(
                    encodeAgentSettingsDiscoveryFailedEvent({
                        code: "runtime_offline",
                        kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                        message: "The local runtime is offline",
                        requestId,
                    }),
                );
            }
        }
        this.#pendingAgentSettingsDiscoveries.clear();
    };

    private readonly sendToDaemon = (message: ServiceToDaemonMessage): boolean => {
        const daemon = this.#peers.daemons().find((socket) => socket.isOpen());
        if (daemon === undefined) {
            return false;
        }
        try {
            daemon.send(encodeServiceToDaemonMessage(message));
            return true;
        } catch {
            return false;
        }
    };

    private readonly acceptAndDeliverInteractionResponse = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        response: Readonly<{
            content: string;
            kind: "elicitation" | "permission";
        }>,
        payload: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const accepted = await this.#commands.acceptInteractionResponse(
            scope,
            sessionId,
            interactionId,
            "project-client",
            response,
            payload,
            this.#clock.now(),
            signal,
        );
        if (accepted.pendingWork.state.kind === "completed") {
            return;
        }
        await this.dispatchPending(signal);
    };

    private readonly sendInteractionFailure = (
        socket: ChannelSocket,
        sessionId: string,
        interactionId: string,
        error: unknown,
    ): boolean => {
        if (!(error instanceof SessionRuntimeError)) {
            return false;
        }
        socket.send(
            encodeSessionOperationFailedEvent({
                code: error.code,
                kind: SESSION_OPERATION_FAILED_KIND,
                message: error.message,
                requestId: interactionId,
                sessionId,
            }),
        );
        return true;
    };

    readonly dispatchPending = async (signal: AbortSignal): Promise<void> => {
        const operation = this.#dispatchTail.then(async () => {
            if (this.#deliveryReceipts) {
                await this.#dispatchReliablePending(signal);
                return;
            }
            await this.#dispatchLegacyPending(signal);
        });
        this.#dispatchTail = operation.catch(() => undefined);
        await operation;
    };

    readonly #dispatchLegacyPending = async (signal: AbortSignal): Promise<void> => {
        let delivered = 0;
        while (delivered < 500) {
            const batch = await this.#commands.listPendingDaemonDeliveries(
                this.#scope,
                this.#runtimeId,
                Math.min(100, 500 - delivered),
                signal,
            );
            if (batch.length === 0) {
                return;
            }
            for (const delivery of batch) {
                signal.throwIfAborted();
                // Record before handing off: a disconnect may run before the Runtime answers, and an extra
                // recorded Session only costs one idempotent settle while a missed one strands the Attempt.
                this.recordActiveSession(delivery.pendingWork.sessionId);
                if (!this.sendToDaemon(decodeServiceToDaemonMessage(delivery.payload))) {
                    return;
                }
                await this.#commands.markPendingWorkCompleted(
                    this.#scope,
                    delivery.pendingWork.sessionId,
                    delivery.pendingWork.workId,
                    this.#clock.now(),
                    signal,
                );
                delivered += 1;
            }
            if (batch.length < 100) {
                return;
            }
        }
    };

    readonly #dispatchReliablePending = async (signal: AbortSignal): Promise<void> => {
        while (this.#inFlightDeliveries.size < RUNTIME_DELIVERY_WINDOW) {
            const batch = await this.#commands.listPendingDaemonDeliveries(this.#scope, this.#runtimeId, 100, signal);
            let sent = 0;
            for (const delivery of batch) {
                signal.throwIfAborted();
                if (this.#inFlightDeliveries.has(delivery.pendingWork.workId)) {
                    continue;
                }
                const daemonMessage = {
                    deliveryId: delivery.pendingWork.workId,
                    kind: RUNTIME_DELIVERY_KIND,
                    payload: delivery.payload,
                    sessionId: delivery.pendingWork.sessionId,
                } as const;
                const encoded = encodeServiceToDaemonMessage(daemonMessage);
                const byteLength = new TextEncoder().encode(encoded).byteLength;
                if (this.#inFlightDeliveryBytes + byteLength > RUNTIME_DELIVERY_BYTE_LIMIT) {
                    continue;
                }
                // Record before handing off: a disconnect may run before the Runtime answers, and an extra
                // recorded Session only costs one idempotent settle while a missed one strands the Attempt.
                this.recordActiveSession(delivery.pendingWork.sessionId);
                if (!this.sendToDaemon(daemonMessage)) {
                    return;
                }
                this.#inFlightDeliveries.set(delivery.pendingWork.workId, byteLength);
                this.#inFlightDeliveryBytes += byteLength;
                sent += 1;
                if (this.#inFlightDeliveries.size >= RUNTIME_DELIVERY_WINDOW) {
                    return;
                }
            }
            if (sent === 0 || batch.length < 100) {
                return;
            }
        }
    };

    readonly #removeInFlightDelivery = (deliveryId: string): void => {
        const byteLength = this.#inFlightDeliveries.get(deliveryId);
        if (byteLength === undefined) {
            return;
        }
        this.#inFlightDeliveries.delete(deliveryId);
        this.#inFlightDeliveryBytes -= byteLength;
    };

    readonly #clearInFlightDeliveries = (): void => {
        this.#inFlightDeliveries.clear();
        this.#inFlightDeliveryBytes = 0;
    };

    private readonly hasOnlineDaemon = (): boolean => this.#peers.daemons().some((socket) => socket.isOpen());

    private readonly broadcastRuntimeStatus = (online: boolean): void => {
        this.broadcast(
            this.#peers.hosts(),
            encodeRuntimeStatusEvent({
                kind: RUNTIME_STATUS_KIND,
                online,
                runtimeId: this.#runtimeId,
            }),
        );
    };

    private readonly broadcast = (sockets: readonly ChannelSocket[], message: string): void => {
        for (const socket of sockets) {
            if (socket.isOpen()) {
                socket.send(message);
            }
        }
    };
}
