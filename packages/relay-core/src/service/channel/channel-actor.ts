import {
    AGENT_CATALOG_DISCOVER_KIND,
    AGENT_CATALOG_DISCOVERED_KIND,
    AGENT_CATALOG_DISCOVERY_FAILED_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    CONTENT_AVAILABLE_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_READY_KIND,
    CONTENT_WRITE_KIND,
    type DaemonToRelayMessage,
    type DaemonToServiceMessage,
    decodeAgentCatalogDiscoverCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeContentChunkFrame,
    decodeContentCommitCommand,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    decodeKnownServiceToDaemonMessage,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionRequest,
    decodeRuntimeDiagnosticsRequest,
    decodeRuntimePingCommand,
    decodeSessionCancelBeforeStartCommand,
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
    decodeWorkspaceListCommand,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    encodeSessionOperationFailedEvent,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    isIdentifier,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionCommand,
    ProtocolMessageError,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSE_NOTICE_KIND,
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
    type ServiceToDaemonMessage,
    type SessionPromptCommand,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import { logger } from "../../infra/logger.ts";
import type { SessionStatusNotifications } from "../../infra/session-status-notifications.ts";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import { SessionLiveEventRelay } from "./session-live-event-relay.ts";

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1013 {
    if (error.code === "session_busy") {
        return 1013;
    }
    return 1008;
}

function copyBinaryFrame(value: unknown): ArrayBuffer {
    if (value instanceof ArrayBuffer) {
        return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    }
    throw new ProtocolMessageError("Content chunk must be binary");
}

function knownChunk(value: unknown, skipped: () => void) {
    try {
        return decodeContentChunkFrame(value);
    } catch {
        skipped();
        return null;
    }
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
    readonly send: (message: string | ArrayBuffer) => void;
    readonly trackAgentSettingsDiscovery: (requestId: string, agentId: string) => "tracked" | "duplicate" | "busy";
}

export interface ChannelPeers {
    readonly viewers: () => readonly {
        readonly socket: ChannelSocket;
        readonly sessionId: string;
        readonly expiresAt: number;
        readonly eventFormat: "events" | "envelope";
    }[];
    readonly operations: () => readonly {
        readonly socket: ChannelSocket;
        readonly requestId: string;
        readonly sessionId: string;
        readonly queueAcknowledgement: boolean;
    }[];
    readonly daemons: () => readonly ChannelSocket[];
    readonly hosts: () => readonly ChannelSocket[];
    readonly nativeRequests: () => readonly { readonly requestId: string; readonly socket: ChannelSocket }[];
    readonly historyRecipients: () => readonly ChannelSocket[];
}

export class ChannelActor {
    #lastSkippedLogAt = Number.NEGATIVE_INFINITY;
    #skippedCount = 0;

    readonly recordSkipped = (reason: string): void => {
        this.#skippedCount += 1;
        const now = Date.now();
        if (now - this.#lastSkippedLogAt < 60_000) {
            return;
        }
        logger.warn(
            {
                event: "relay_message_skipped",
                reason,
                skippedCount: this.#skippedCount,
                runtimeId: this.#runtimeId,
                projectId: this.#projectId,
            },
            "Relay skipped unsupported input",
        );
        this.#lastSkippedLogAt = now;
        this.#skippedCount = 0;
    };
    readonly #peers: ChannelPeers;
    readonly #projectId: string;
    readonly #runtimeId: string;
    readonly #liveEvents: SessionLiveEventRelay;

    constructor(cx: {
        readonly config: { readonly projectId: string; readonly runtimeId: string };
        readonly gateways: {
            readonly peers: ChannelPeers;
            readonly recording: BestEffortRecording;
            readonly notifications?: SessionStatusNotifications;
        };
    }) {
        const { projectId, runtimeId } = cx.config;
        const { peers, recording, notifications } = cx.gateways;
        this.#peers = peers;
        this.#projectId = projectId;
        this.#runtimeId = runtimeId;
        this.#liveEvents = new SessionLiveEventRelay(projectId, runtimeId, peers, recording, notifications);
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
        message: DaemonToRelayMessage | null,
        signal: AbortSignal,
        encoded?: string,
    ): Promise<void> => {
        try {
            if (message === null) {
                if (encoded === undefined) {
                    this.recordSkipped("missing_daemon_payload");
                    return;
                }
                let value: unknown;
                try {
                    value = JSON.parse(encoded);
                } catch {
                    this.recordSkipped("invalid_daemon_json");
                    return;
                }
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    this.recordSkipped("unsupported_daemon_envelope");
                    return;
                }
                const sessionId: unknown = Reflect.get(value, "sessionId");
                const kind: unknown = Reflect.get(value, "kind");
                if (typeof kind !== "string" || kind.length === 0 || kind.length > 64 || !isIdentifier(sessionId)) {
                    this.recordSkipped("unroutable_daemon_message");
                    return;
                }
                // The authenticated daemon owns its output. Unknown payloads can
                // reach only hosts subscribed to their explicit Session.
                const requestId: unknown = Reflect.get(value, "requestId");
                this.broadcast(
                    [
                        ...this.#peers.hosts(),
                        ...this.#peers
                            .operations()
                            .filter((route) => route.requestId === requestId && route.sessionId === sessionId)
                            .map((route) => route.socket),
                    ],
                    encoded,
                    sessionId,
                );
                return;
            }
            const wire = encoded ?? JSON.stringify(message);
            const kind = message.kind;
            if (kind === SESSION_EVENT_KIND) {
                this.#liveEvents.receive(message);
                return;
            }
            if (kind === SESSION_INFO_UPDATED_KIND) {
                this.broadcast(
                    this.#peers.hosts(),
                    JSON.stringify({ ...JSON.parse(wire), projectId: this.#projectId }),
                    message.sessionId,
                );
                return;
            }
            if (kind === NATIVE_SESSION_RESULT_KIND || kind === SESSION_OPERATION_FAILED_KIND) {
                this.broadcast(
                    [
                        ...this.#peers.hosts(),
                        ...this.#peers
                            .operations()
                            .filter((route) => route.requestId === message.requestId)
                            .map(({ socket }) => socket),
                        ...this.#peers
                            .nativeRequests()
                            .filter(({ requestId }) => requestId === message.requestId)
                            .map(({ socket }) => socket),
                    ],
                    wire,
                    message.sessionId,
                );
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERED_KIND) {
                this.returnAgentSettingsDiscoveryResult(message.requestId, message.agentId, wire);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERY_FAILED_KIND) {
                this.returnAgentSettingsDiscoveryFailure(message.requestId, wire);
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
            if ("requestId" in message || "interactionId" in message) {
                const id = "requestId" in message ? message.requestId : message.interactionId;
                this.broadcast(
                    this.#peers
                        .operations()
                        .filter((route) => route.requestId === id)
                        .map(({ socket }) => socket),
                    wire,
                );
            }
            this.broadcast(this.#peers.hosts(), wire, "sessionId" in message ? message.sessionId : undefined);
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

    readonly receiveDaemonChunk = (_socket: ChannelSocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_daemon_frame"));
        if (chunk === null) {
            return;
        }
        const recipient = this.#peers
            .operations()
            .find((route) => route.requestId === chunk.requestId && route.socket.isOpen())?.socket;
        if (recipient === undefined) {
            // The HTTP caller can cancel after the daemon has already queued its next
            // chunk. The operation route is gone by the time that frame arrives, but
            // this is not a daemon protocol violation and must not interrupt unrelated
            // Sessions sharing the Runtime connection.
            return;
        }
        recipient.send(copyBinaryFrame(message));
    };

    readonly receiveHostChunk = (socket: ChannelSocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_host_frame"));
        if (chunk === null) {
            return;
        }
        const ownsOperation = this.#peers
            .operations()
            .some((route) => route.requestId === chunk.requestId && route.socket.isSame(socket));
        if (!ownsOperation) {
            throw new ProtocolMessageError("Content chunk does not belong to this operation");
        }
        const daemon = this.#peers.daemons().find((candidate) => candidate.isOpen());
        if (daemon === undefined) {
            throw new SessionRuntimeError("runtime_offline", "The local runtime is offline");
        }
        daemon.send(copyBinaryFrame(message));
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
            if (decodeKnownServiceToDaemonMessage(message) === null) {
                this.recordSkipped("unsupported_host_message");
                return;
            }
            const kind = decodeMessageKind(message);
            if (kind === SESSION_PROMPT_KIND) {
                const command = decodeSessionPromptCommand(message);
                this.forwardPrompt(socket, command, message);
                return;
            }
            if (kind === SESSION_PREPARE_KIND) {
                const command = decodeSessionPrepareCommand(message);
                this.forwardControl(socket, command, command.requestId, command.sessionId, command, message);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
                const command = decodeAgentSettingsDiscoverCommand(message);
                this.forwardAgentSettingsDiscovery(socket, command, command.requestId, command.agentId, message);
                return;
            }
            if (kind === NATIVE_SESSION_REQUEST_KIND) {
                const request = decodeNativeSessionRequest(message);
                const command: NativeSessionCommand = decodeNativeSessionCommand(message);
                this.forwardControl(socket, command, request.requestId, request.sessionId, request, message);
                return;
            }
            if (kind === SESSION_HISTORY_PAGE_LOAD_KIND) {
                if (!socket.permitsSessionHistory()) {
                    throw new ProtocolMessageError("Live Session history requires an internal connection");
                }
                this.forwardHistoryPage(socket, "live", decodeSessionHistoryPageLoad(message), message);
                return;
            }
            if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND) {
                if (!socket.permitsSessionHistory()) {
                    throw new ProtocolMessageError("Session preview history requires an internal connection");
                }
                this.forwardHistoryPage(socket, "preview", decodeSessionPreviewHistoryPageLoad(message), message);
                return;
            }
            if (kind === SESSION_PERMISSION_RESPOND_KIND) {
                const command = decodeSessionPermissionRespondCommand(message);
                this.forwardControl(socket, command, command.interactionId, command.sessionId, command, message);
                return;
            }
            if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                const command = decodeSessionElicitationRespondCommand(message);
                this.forwardControl(socket, command, command.interactionId, command.sessionId, command, message);
                return;
            }
            const control = this.validateHostControl(kind, message);
            if (control === null) {
                return;
            }
            this.forwardControl(
                socket,
                control.message,
                control.requestId,
                control.sessionId,
                control.message,
                message,
            );
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
            case AGENT_SETTINGS_DISCOVERED_KIND:
                return;
            case AGENT_SETTINGS_DISCOVERY_FAILED_KIND:
                return;
            case AGENT_CATALOG_DISCOVERED_KIND:
                return;
            case AGENT_CATALOG_DISCOVERY_FAILED_KIND:
                return;
            case FILE_BEGIN_KIND:
                return;
            case FILE_END_KIND:
                return;
            case FILE_FAILED_KIND:
                return;
            case CONTENT_READY_KIND:
                return;
            case CONTENT_AVAILABLE_KIND:
                return;
            case SESSION_QUERIED_KIND:
                return;
            case SESSION_RESTORED_KIND:
                return;
            case SESSION_CLOSED_KIND:
                return;
            case SESSION_CLOSE_NOTICE_KIND:
                return;
            case SESSION_LISTED_KIND:
                return;
            case SESSION_CONFIG_UPDATED_KIND:
                return;
            case SESSION_CONFIG_READ_RESULT_KIND:
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
                return;
        }
    };

    private readonly validateHostControl = (
        kind: string,
        message: string,
    ): {
        readonly message: ServiceToDaemonMessage;
        readonly requestId: string;
        readonly sessionId: string;
    } | null => {
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
            case SESSION_CANCEL_BEFORE_START_KIND: {
                const command = decodeSessionCancelBeforeStartCommand(message);
                return { message: command, requestId: command.commandId, sessionId: command.sessionId };
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
            case AGENT_CATALOG_DISCOVER_KIND: {
                const command = decodeAgentCatalogDiscoverCommand(message);
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
            case CONTENT_WRITE_KIND: {
                const command = decodeContentWriteCommand(message);
                return { message: command, requestId: command.requestId, sessionId: command.sessionId };
            }
            case CONTENT_COMMIT_KIND: {
                const command = decodeContentCommitCommand(message);
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
                return null;
        }
    };

    private readonly forwardControl = (
        socket: ChannelSocket,
        message: ServiceToDaemonMessage,
        requestId: string,
        sessionId: string,
        broadcastMessage: ServiceToDaemonMessage = message,
        encoded?: string,
    ): void => {
        if (!this.sendToDaemon(message, encoded)) {
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
            broadcastMessage === message && encoded !== undefined
                ? encoded
                : encodeServiceToDaemonMessage(broadcastMessage),
            sessionId.length === 0 ? undefined : sessionId,
        );
    };

    private readonly forwardPrompt = (socket: ChannelSocket, command: SessionPromptCommand, encoded: string): void => {
        if (!this.sendToDaemon(command, encoded)) {
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
        encoded?: string,
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
        if (!this.sendToDaemon(message, encoded)) {
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
        const recipient = [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)].find(
            (socket) => socket.consumeAgentSettingsDiscovery(requestId, agentId),
        );
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnAgentSettingsDiscoveryFailure = (requestId: string, message: string): void => {
        const recipient = [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)].find(
            (socket) => socket.consumeAgentSettingsDiscoveryFailure(requestId),
        );
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnHistoryPage = (
        kind: HistoryRequestKind,
        message: Extract<
            DaemonToRelayMessage,
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
        recipient?.send(JSON.stringify(message));
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
        encoded: string,
    ): void => {
        // Internal history connections belong to one operation; only its reply address survives hibernation.
        socket.bindHistoryRequest(kind, command.requestId);
        if (!this.sendToDaemon(command, encoded)) {
            socket.close(1013, "Runtime offline");
        }
    };

    private readonly failPendingAgentSettingsDiscoveries = (): void => {
        for (const socket of [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)]) {
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

    private readonly sendToDaemon = (message: ServiceToDaemonMessage, encoded?: string): boolean => {
        const daemon = this.#peers.daemons().find((socket) => socket.isOpen());
        if (daemon === undefined) {
            return false;
        }
        try {
            daemon.send(encoded ?? encodeServiceToDaemonMessage(message));
            return true;
        } catch {
            return false;
        }
    };

    private readonly hasOnlineDaemon = (): boolean => this.#peers.daemons().some((socket) => socket.isOpen());

    private readonly broadcastRuntimeStatus = (online: boolean): void => {
        if (!online) {
            for (const { socket } of this.#peers.viewers()) {
                socket.close(1000, "Runtime offline");
            }
        }
        this.broadcast(
            [
                ...this.#peers.hosts(),
                ...this.#peers.operations().map(({ socket }) => socket),
                ...this.#peers.nativeRequests().map(({ socket }) => socket),
            ],
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
