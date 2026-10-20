import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type DaemonToServiceMessage,
    decodeAgentSettingsDiscoverCommand,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionRequest,
    decodeRuntimeDiagnosticsRequest,
    decodeRuntimePingCommand,
    decodeSessionCancelCommand,
    decodeSessionCloseCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionListCommand,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueryCommand,
    decodeSessionRenameCommand,
    decodeSessionRestoreCommand,
    decodeSessionUsageReadCommand,
    decodeWorkspaceListCommand,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeDaemonToServiceMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    encodeSessionOperationFailedEvent,
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
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_KIND,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_READY_KIND,
    SESSION_RENAME_KIND,
    SESSION_RENAMED_KIND,
    SESSION_RESTORE_KIND,
    SESSION_RESTORED_KIND,
    SESSION_STATUS_CHANGED_KIND,
    SESSION_USAGE_READ_KIND,
    SESSION_USAGE_READ_RESULT_KIND,
    type ServiceToDaemonMessage,
    type SessionPromptCommand,
    UnsupportedProtocolMessageKindError,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import { SessionLiveEventRelay } from "./session-live-event-relay.ts";

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1013 {
    if (error.code === "session_busy") {
        return 1013;
    }
    return 1008;
}

export type HistoryRequestKind = "live" | "preview";

export interface ChannelSocket {
    readonly sessionFilter?: string | undefined;
    readonly close: (code: number, reason: string) => void;
    readonly consumeAgentSettingsDiscovery: (requestId: string, agentId: string) => boolean;
    readonly consumeAgentSettingsDiscoveryFailure: (requestId: string) => boolean;
    readonly takeAgentSettingsDiscoveries: () => readonly string[];
    readonly bindHistoryRequest: (kind: HistoryRequestKind, requestId: string) => void;
    readonly matchesHistoryRequest: (kind: HistoryRequestKind, requestId: string) => boolean;
    readonly isOpen: () => boolean;
    readonly isSame: (socket: ChannelSocket) => boolean;
    readonly permitsSessionHistory: () => boolean;
    readonly send: (message: string) => void;
    readonly trackAgentSettingsDiscovery: (requestId: string, agentId: string) => "tracked" | "duplicate" | "busy";
}

export interface ChannelPeers {
    readonly daemons: () => readonly ChannelSocket[];
    readonly hosts: () => readonly ChannelSocket[];
    readonly nativeRequests: () => readonly { readonly requestId: string; readonly socket: ChannelSocket }[];
    readonly historyRecipients: () => readonly ChannelSocket[];
}

export class ChannelActor {
    readonly #peers: ChannelPeers;
    readonly #projectId: string;
    readonly #runtimeId: string;
    readonly #liveEvents: SessionLiveEventRelay;

    constructor(cx: {
        readonly config: { readonly projectId: string; readonly runtimeId: string };
        readonly gateways: {
            readonly peers: ChannelPeers;
            readonly recording: BestEffortRecording;
        };
    }) {
        const { projectId, runtimeId } = cx.config;
        const { peers, recording } = cx.gateways;
        this.#peers = peers;
        this.#projectId = projectId;
        this.#runtimeId = runtimeId;
        this.#liveEvents = new SessionLiveEventRelay(projectId, runtimeId, peers, recording);
    }

    readonly attachDaemon = async (replacedExistingConnection: boolean, _signal: AbortSignal): Promise<void> => {
        if (replacedExistingConnection) {
            this.failPendingAgentSettingsDiscoveries();
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
            if (kind === SESSION_INFO_UPDATED_KIND) {
                this.broadcast(
                    this.#peers.hosts(),
                    encodeDaemonToServiceMessage({ ...message, projectId: this.#projectId }),
                    message.sessionId,
                );
                return;
            }
            if (kind === NATIVE_SESSION_RESULT_KIND || kind === SESSION_OPERATION_FAILED_KIND) {
                this.broadcast(
                    [
                        ...this.#peers.hosts(),
                        ...this.#peers
                            .nativeRequests()
                            .filter(({ requestId }) => requestId === message.requestId)
                            .map(({ socket }) => socket),
                    ],
                    encodeDaemonToServiceMessage(message),
                    message.sessionId,
                );
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
            if (kind === SESSION_HISTORY_PAGE_LOADED_KIND) {
                this.returnHistoryPage("live", message);
                return;
            }
            if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) {
                this.returnHistoryPage("preview", message);
                return;
            }
            this.validateDaemonControl(message);
            this.broadcast(
                this.#peers.hosts(),
                encodeDaemonToServiceMessage(message),
                "sessionId" in message ? message.sessionId : undefined,
            );
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
                this.forwardControl(socket, command, request.requestId, request.sessionId, request);
                return;
            }
            if (kind === SESSION_HISTORY_PAGE_LOAD_KIND) {
                if (!socket.permitsSessionHistory()) {
                    throw new ProtocolMessageError("Live Session history requires an internal connection");
                }
                this.forwardHistoryPage(socket, "live", decodeSessionHistoryPageLoad(message));
                return;
            }
            if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND) {
                if (!socket.permitsSessionHistory()) {
                    throw new ProtocolMessageError("Session preview history requires an internal connection");
                }
                this.forwardHistoryPage(socket, "preview", decodeSessionPreviewHistoryPageLoad(message));
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
            case SESSION_RESTORED_KIND:
                return;
            case SESSION_CLOSED_KIND:
                return;
            case SESSION_LISTED_KIND:
                return;
            case SESSION_CONFIG_UPDATED_KIND:
                return;
            case SESSION_CONFIG_READ_RESULT_KIND:
                return;
            case SESSION_USAGE_READ_RESULT_KIND:
                return;
            case SESSION_RENAMED_KIND:
                return;
            case SESSION_STATUS_CHANGED_KIND:
                return;
            case NATIVE_SESSION_RESULT_KIND:
                return;
            case WORKSPACE_ENTRIES_KIND:
                return;
            case "runtime.upgrade.result":
            case "runtime.diagnostics.result":
            case RUNTIME_PONG_KIND:
                return;
            case SESSION_OPERATION_FAILED_KIND:
                return;
            case SESSION_READY_KIND:
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
            case SESSION_RESTORE_KIND: {
                const command = decodeSessionRestoreCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_CLOSE_KIND: {
                const command = decodeSessionCloseCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_LIST_KIND: {
                const command = decodeSessionListCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case SESSION_CONFIGURE_KIND: {
                const command = decodeSessionConfigureCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_CONFIG_READ_KIND: {
                const command = decodeSessionConfigReadCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_USAGE_READ_KIND: {
                const command = decodeSessionUsageReadCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case SESSION_RENAME_KIND: {
                const command = decodeSessionRenameCommand(message);
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
            case FILE_READ_KIND: {
                const command = decodeFileReadCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case "runtime.diagnostics.read": {
                const command = decodeRuntimeDiagnosticsRequest(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            case RUNTIME_PING_KIND: {
                const command = decodeRuntimePingCommand(message);
                return { message: command, requestId: command.requestId, sessionId: "" };
            }
            default:
                throw new UnsupportedProtocolMessageKindError("service-to-daemon", kind);
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
                encodeSessionOperationFailedEvent({
                    code: "runtime_offline",
                    kind: SESSION_OPERATION_FAILED_KIND,
                    message: "The local runtime is offline",
                    requestId,
                    sessionId: sessionId.length === 0 ? "runtime" : sessionId,
                }),
            );
            return;
        }
        this.broadcast(
            this.#peers.hosts(),
            encodeServiceToDaemonMessage(broadcastMessage),
            sessionId.length === 0 ? undefined : sessionId,
        );
    };

    private readonly forwardPrompt = (socket: ChannelSocket, command: SessionPromptCommand): void => {
        if (!this.sendToDaemon(command)) {
            socket.send(
                encodeSessionOperationFailedEvent({
                    code: "runtime_offline",
                    kind: SESSION_OPERATION_FAILED_KIND,
                    message: "The local runtime is offline",
                    requestId: command.commandId,
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
        const route = socket.trackAgentSettingsDiscovery(requestId, agentId);
        if (route === "duplicate") {
            return;
        }
        if (route === "busy") {
            socket.send(
                encodeAgentSettingsDiscoveryFailedEvent({
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "This connection already has pending settings discovery requests",
                    requestId,
                }),
            );
            return;
        }
        if (!this.sendToDaemon(message)) {
            socket.consumeAgentSettingsDiscoveryFailure(requestId);
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
        const recipient = this.#peers
            .hosts()
            .find((socket) => socket.consumeAgentSettingsDiscovery(requestId, agentId));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnAgentSettingsDiscoveryFailure = (requestId: string, message: string): void => {
        const recipient = this.#peers.hosts().find((socket) => socket.consumeAgentSettingsDiscoveryFailure(requestId));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnHistoryPage = (
        kind: HistoryRequestKind,
        message: Extract<
            DaemonToServiceMessage,
            {
                readonly kind:
                    | typeof SESSION_HISTORY_PAGE_LOADED_KIND
                    | typeof SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND;
            }
        >,
    ): void => {
        const recipient = this.#peers
            .historyRecipients()
            .find((socket) => socket.isOpen() && socket.matchesHistoryRequest(kind, message.requestId));
        // A caller can close or time out independently of the authenticated daemon.
        recipient?.send(encodeDaemonToServiceMessage(message));
    };

    private readonly forwardHistoryPage = (
        socket: ChannelSocket,
        kind: HistoryRequestKind,
        command: Extract<
            ServiceToDaemonMessage,
            {
                readonly kind: typeof SESSION_HISTORY_PAGE_LOAD_KIND | typeof SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND;
            }
        >,
    ): void => {
        // Internal history connections belong to one operation; only its reply address survives hibernation.
        socket.bindHistoryRequest(kind, command.requestId);
        if (!this.sendToDaemon(command)) {
            socket.close(1013, "Runtime offline");
        }
    };

    private readonly failPendingAgentSettingsDiscoveries = (): void => {
        for (const socket of this.#peers.hosts()) {
            for (const requestId of socket.takeAgentSettingsDiscoveries()) {
                if (socket.isOpen()) {
                    socket.send(
                        encodeAgentSettingsDiscoveryFailedEvent({
                            code: "runtime_offline",
                            kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                            message: "The local runtime is offline",
                            requestId,
                        }),
                    );
                }
            }
        }
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
            [...this.#peers.hosts(), ...this.#peers.nativeRequests().map(({ socket }) => socket)],
            encodeRuntimeStatusEvent({
                kind: RUNTIME_STATUS_KIND,
                online,
                runtimeId: this.#runtimeId,
            }),
        );
    };

    private readonly broadcast = (sockets: readonly ChannelSocket[], message: string, sessionId?: string): void => {
        for (const socket of sockets) {
            if (sessionId !== undefined && socket.sessionFilter !== undefined && socket.sessionFilter !== sessionId) {
                continue;
            }
            if (socket.isOpen()) {
                socket.send(message);
            }
        }
    };
}
