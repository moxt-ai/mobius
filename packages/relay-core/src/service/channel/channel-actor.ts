import {
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
    decodeAgentInstallCancelCommand,
    decodeAgentInstallRequestCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionRequest,
    decodeRuntimePingCommand,
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionListCommand,
    decodeSessionLiveHistoryV2PageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueryCommand,
    decodeWorkspaceListCommand,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeDaemonToServiceMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    encodeSessionFailedEvent,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionCommand,
    ProtocolMessageError,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_QUEUED_KIND,
    SESSION_READY_KIND,
    SESSION_STATUS_CHANGED_KIND,
    type ServiceToDaemonMessage,
    type SessionPromptCommand,
    UnsupportedProtocolMessageKindError,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import { LiveSessionEventRelay } from "./live-session-event-relay.ts";

type NativeImportAction = "import" | "fork";

function isNativeImportAction(action: string): action is NativeImportAction {
    return action === "import" || action === "fork";
}

const NATIVE_IMPORT_DEADLINE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_PENDING_NATIVE_IMPORTS = 4;
const AGENT_SETTINGS_DISCOVERY_DEADLINE_MILLISECONDS = 2 * 60 * 1_000;

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

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1013 {
    if (error.code === "session_busy") {
        return 1013;
    }
    return 1008;
}

export interface RelayClock {
    readonly now: () => number;
}

export class SystemRelayClock implements RelayClock {
    readonly now = (): number => Date.now();
}

export interface ChannelSocket {
    readonly close: (code: number, reason: string) => void;
    readonly consumeAgentSettingsDiscovery: (requestId: string, agentId: string, now: number) => boolean;
    readonly consumeAgentSettingsDiscoveryFailure: (requestId: string, now: number) => boolean;
    readonly isOpen: () => boolean;
    readonly isSame: (socket: ChannelSocket) => boolean;
    readonly permitsLiveSessionHistory: () => boolean;
    readonly send: (message: string) => void;
    readonly trackAgentSettingsDiscovery: (requestId: string, agentId: string, expiresAt: number) => void;
}

export interface ChannelPeers {
    readonly daemons: () => readonly ChannelSocket[];
    readonly hosts: () => readonly ChannelSocket[];
}

export class ChannelActor {
    readonly #pendingAgentSettingsDiscoveries = new Map<string, PendingAgentSettingsDiscovery>();
    readonly #pendingLiveSessionHistory = new Map<
        string,
        { readonly expiresAt: number; readonly socket: ChannelSocket }
    >();
    readonly #pendingNativeImports = new Map<
        string,
        {
            readonly action: NativeImportAction;
            readonly sessionId: string;
            readonly agentId: string;
            readonly directoryId: string;
            readonly expiresAt: number;
        }
    >();
    readonly #clock: RelayClock;
    readonly #peers: ChannelPeers;
    readonly #runtimeId: string;
    readonly #liveEvents: LiveSessionEventRelay;

    constructor(cx: {
        readonly config: { readonly projectId: string; readonly runtimeId: string };
        readonly gateways: {
            readonly peers: ChannelPeers;
            readonly recording: BestEffortRecording;
            readonly clock?: RelayClock;
        };
    }) {
        const { projectId, runtimeId } = cx.config;
        const { peers, recording, clock = new SystemRelayClock() } = cx.gateways;
        this.#clock = clock;
        this.#peers = peers;
        this.#runtimeId = runtimeId;
        this.#liveEvents = new LiveSessionEventRelay(projectId, runtimeId, peers, recording);
    }

    readonly attachDaemon = async (replacedExistingConnection: boolean, _signal: AbortSignal): Promise<void> => {
        if (replacedExistingConnection) {
            this.failPendingAgentSettingsDiscoveries();
            this.#pendingNativeImports.clear();
        }
        this.broadcastRuntimeStatus(true);
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

    readonly detachDaemon = async (socket: ChannelSocket, _signal: AbortSignal): Promise<void> => {
        const anotherDaemonOnline = this.#peers
            .daemons()
            .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
        if (anotherDaemonOnline) {
            return;
        }
        this.failPendingAgentSettingsDiscoveries();
        this.#pendingNativeImports.clear();
        this.broadcastRuntimeStatus(false);
    };

    readonly receiveDaemonMessage = async (
        socket: ChannelSocket,
        message: DaemonToServiceMessage,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            const kind = message.kind;
            if (kind === SESSION_EVENT_KIND) {
                this.#liveEvents.receive(message);
                return;
            }
            if (kind === SESSION_EVENT_V2_KIND) {
                this.broadcast(this.#peers.hosts(), encodeDaemonToServiceMessage(message));
                return;
            }
            if (kind === NATIVE_SESSION_RESULT_KIND) {
                const result = message;
                if (isNativeImportAction(result.action)) {
                    const pending = this.#pendingNativeImports.get(result.requestId);
                    if (
                        pending === undefined ||
                        pending.expiresAt <= this.#clock.now() ||
                        pending.action !== result.action ||
                        pending.sessionId !== result.targetSessionId ||
                        pending.agentId !== result.ready.agentId
                    ) {
                        throw new ProtocolMessageError("The native session result does not match a pending import");
                    }
                    if (pending.directoryId !== result.ready.directoryId) {
                        throw new ProtocolMessageError("The native session result resolved to a different binding");
                    }
                }
                this.broadcast(this.#peers.hosts(), encodeDaemonToServiceMessage(message));
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
            if (kind === SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND) {
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
            if (error instanceof UnsupportedProtocolMessageKindError) {
                console.warn("Runtime message skipped", {
                    code: error.code,
                    direction: error.direction,
                    messageKind: error.messageKind,
                });
                return;
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

    readonly receiveHostMessage = async (
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
                this.forwardPrompt(socket, command);
                return;
            }
            if (kind === SESSION_PREPARE_KIND) {
                const command = decodeSessionPrepareCommand(message);
                this.forwardControl(socket, command, command.requestId, command.sessionId);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
                const command = decodeAgentSettingsDiscoverCommand(message);
                this.forwardAgentSettingsDiscovery(socket, command, command.requestId, command.agentId);
                return;
            }
            if (kind === NATIVE_SESSION_REQUEST_KIND) {
                const request = decodeNativeSessionRequest(message);
                const command: NativeSessionCommand = decodeNativeSessionCommand(message);
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
                            sessionId: request.targetSessionId,
                            agentId: request.agentId,
                            directoryId: request.directoryId,
                            expiresAt: now + NATIVE_IMPORT_DEADLINE_MILLISECONDS,
                        });
                    }
                }
                this.forwardControl(socket, command, request.requestId, request.sessionId, request);
                return;
            }
            if (kind === SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND) {
                if (!socket.permitsLiveSessionHistory()) {
                    throw new ProtocolMessageError("Live Session history requires an internal connection");
                }
                const command = decodeSessionLiveHistoryV2PageLoad(message);
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
                this.forwardControl(socket, command, command.interactionId, command.sessionId);
                return;
            }
            if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                const command = decodeSessionElicitationRespondCommand(message);
                this.forwardControl(socket, command, command.interactionId, command.sessionId);
                return;
            }
            const control = this.validateHostControl(kind, message);
            this.forwardControl(socket, control.message, control.requestId, control.sessionId);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof UnsupportedProtocolMessageKindError) {
                console.warn("Host message skipped", {
                    code: error.code,
                    direction: error.direction,
                    messageKind: error.messageKind,
                });
                return;
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
            case SESSION_QUERIED_KIND:
                return;
            case SESSION_LISTED_KIND:
                return;
            case SESSION_STATUS_CHANGED_KIND:
                return;
            case SESSION_QUEUED_KIND:
                return;
            case NATIVE_SESSION_RESULT_KIND:
                return;
            case WORKSPACE_ENTRIES_KIND:
                return;
            case RUNTIME_PONG_KIND:
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
                throw new UnsupportedProtocolMessageKindError("daemon-to-service", message.kind);
        }
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
            case SESSION_PROMPT_DISPOSITION_KIND: {
                const command = decodeSessionPromptDispositionCommand(message);
                return { message: command, requestId: command.commandId, sessionId: command.sessionId };
            }
            case WORKSPACE_LIST_KIND: {
                const command = decodeWorkspaceListCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case SESSION_QUERY_KIND: {
                const command = decodeSessionQueryCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case SESSION_LIST_KIND: {
                const command = decodeSessionListCommand(message);
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
            case RUNTIME_PING_KIND: {
                const command = decodeRuntimePingCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            default:
                throw new UnsupportedProtocolMessageKindError("service-to-daemon", kind);
        }
    };

    private readonly expireNativeImports = (now: number): void => {
        for (const [requestId, pending] of this.#pendingNativeImports) {
            if (pending.expiresAt <= now) {
                this.#pendingNativeImports.delete(requestId);
            }
        }
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

    private readonly forwardPrompt = (socket: ChannelSocket, command: SessionPromptCommand): void => {
        if (!this.sendToDaemon(command)) {
            socket.send(
                encodeSessionFailedEvent({
                    code: "runtime_offline",
                    commandId: command.commandId,
                    kind: SESSION_FAILED_KIND,
                    message: "The local runtime is offline",
                    sessionId: command.sessionId,
                }),
            );
        }
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
