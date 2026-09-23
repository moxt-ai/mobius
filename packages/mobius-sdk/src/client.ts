import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_CONTENT_KIND,
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentActivityNarrationEvent,
    type AgentContentEvent,
    type AgentInstallCancelledEvent,
    type AgentInstallCompletedEvent,
    type AgentInstallFailedEvent,
    type AgentInstallProgressEvent,
    type AgentInstallStartedEvent,
    decodeAgentActivityEvent,
    decodeAgentActivityNarrationEvent,
    decodeAgentContentEvent,
    decodeAgentInstallCancelCommand,
    decodeAgentInstallCancelledEvent,
    decodeAgentInstallCompletedEvent,
    decodeAgentInstallFailedEvent,
    decodeAgentInstallProgressEvent,
    decodeAgentInstallRequestCommand,
    decodeAgentInstallStartedEvent,
    decodeAgentMessageDeltaEvent,
    decodeCommittedSessionEvent,
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    decodeNativeSessionTurnForkRequest,
    decodeRecordedSessionEvent,
    decodeRuntimeStatusEvent,
    decodeSessionCancelCommand,
    decodeSessionCommandsUpdatedEvent,
    decodeSessionCompletedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionElicitationRespondCommand,
    decodeSessionFailedEvent,
    decodeSessionInfoUpdatedEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeSessionReadyEvent,
    decodeSessionStartedEvent,
    decodeSessionUsageUpdatedEvent,
    decodeWorkspaceEntriesEvent,
    decodeWorkspaceListCommand,
    encodeAgentInstallCancelCommand,
    encodeAgentInstallRequestCommand,
    encodeFileReadCommand,
    encodeNativeSessionCancel,
    encodeNativeSessionRequest,
    encodeNativeSessionTurnForkRequest,
    encodeSessionCancelCommand,
    encodeSessionConfigureCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    NATIVE_SESSION_TURN_FORK_REQUEST_KIND,
    type NativeSessionRequest,
    type NativeSessionResult,
    type NativeSessionTurnForkRequest,
    type PromptImage,
    type PromptResource,
    RUNTIME_STATUS_KIND,
    SESSION_CANCEL_KIND,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_READY_KIND,
    SESSION_STARTED_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionCommandsUpdatedEvent,
    type SessionConfigUpdatedEvent,
    type SessionConfigurationSelection,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionElicitationRespondCommand,
    type SessionInfoUpdatedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    SessionPromptDisposition,
    type SessionReadyEvent,
    type SessionUsageUpdatedEvent,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
    type WorkspaceEntriesEvent,
} from "@moxt-ai/mobius-protocol";
import ReconnectingWebSocket, { type CloseEvent as ReconnectingCloseEvent } from "partysocket/ws";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const MAX_RECONNECTION_DELAY_MILLISECONDS = 10_000;
const MIN_RECONNECTION_DELAY_MILLISECONDS = 500;
const OPERATION_TIMEOUT_MILLISECONDS = 120_000;
const INSTALLATION_TIMEOUT_MILLISECONDS = 11 * 60 * 1_000;
const TERMINAL_RELAY_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1003, 1007, 1008, 4003, 4008]);
const HISTORY_CHANGING_MESSAGE_KINDS: ReadonlySet<string> = new Set([
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_CONTENT_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_STARTED_KIND,
]);

export interface ConnectMobiusClientOptions {
    readonly protocols?: readonly string[];
    readonly onNativeSessionResult?: (event: NativeSessionResult) => void;
    readonly onActivity?: () => void;
    readonly onCommands?: (event: SessionCommandsUpdatedEvent) => void;
    readonly onConfig?: (event: SessionConfigUpdatedEvent) => void;
    readonly onContent?: (event: AgentContentEvent) => void;
    readonly onInstallCancelled?: (event: AgentInstallCancelledEvent) => void;
    readonly onInstallCompleted?: (event: AgentInstallCompletedEvent) => void;
    readonly onInstallFailed?: (event: AgentInstallFailedEvent) => void;
    readonly onInstallProgress?: (event: AgentInstallProgressEvent) => void;
    readonly onInstallStarted?: (event: AgentInstallStartedEvent) => void;
    readonly onElicitation?: (event: SessionElicitationRequestedEvent) => void;
    readonly onElicitationResolved?: (event: SessionElicitationResolvedEvent) => void;
    readonly onHistoryChanged?: () => void;
    readonly onInfo?: (event: SessionInfoUpdatedEvent) => void;
    readonly onPermission?: (event: SessionPermissionRequestedEvent) => void;
    readonly onPermissionResolved?: (event: SessionPermissionResolvedEvent) => void;
    readonly onProtocolError?: (error: MobiusClientError) => void;
    readonly onReady?: (event: SessionReadyEvent) => void;
    readonly onReconnecting?: () => void;
    readonly onStatus?: (online: boolean) => void;
    readonly onUnavailable?: () => void;
    readonly onUsage?: (event: SessionUsageUpdatedEvent) => void;
    readonly onWorkspace?: (event: WorkspaceEntriesEvent) => void;
    readonly relayUrl: string;
}

export interface PromptObserver {
    readonly onActivity?: (activity: AgentActivityEvent) => void;
    readonly onContent?: (content: AgentContentEvent) => void;
    readonly onDelta?: (text: string, committedSequence: string) => void;
    readonly onNarration?: (narration: AgentActivityNarrationEvent) => void;
    readonly onStarted?: (attemptId: string) => void;
}

export interface CancelRequest {
    readonly commandId: string;
    readonly sessionId: string;
    readonly turnId?: string;
}

export interface AgentInstallRequest {
    readonly agentId: string;
    readonly requestId?: string;
}

export interface AgentInstallCancelRequest {
    readonly requestId: string;
}

export interface PromptRequest {
    readonly additionalDirectoryIds?: readonly string[];
    readonly agentId: string;
    readonly bindingId: string;
    readonly commandId?: string;
    readonly directoryId?: string;
    readonly disposition?: string;
    readonly images?: readonly PromptImage[];
    readonly observer?: PromptObserver;
    readonly prompt: string;
    readonly resources?: readonly PromptResource[];
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly sessionId?: string;
    readonly targetCommandId?: string;
}

export interface WorkspaceListRequest {
    readonly bindingId: string;
    readonly directoryId: string;
    readonly requestId?: string;
}

export interface SessionPrepareRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly bindingId: string;
    readonly directoryId: string;
    readonly requestId?: string;
    readonly sessionId: string;
    /**
     * Prepares the Session for inspection only, without creating it on the Relay. A conversation this
     * browser has not sent anything to yet needs the Agent's capabilities and commands to render its
     * composer, but it is not a Session the user has started, so it must not appear in the directory.
     */
    readonly transient?: boolean;
}

export interface SessionConfigureRequest extends SessionPrepareRequest {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly value: string;
    readonly valueType: SessionConfigUpdatedEvent["configOptions"][number]["type"];
}

export interface PermissionResponseRequest {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: SessionPermissionResolvedEvent["outcome"];
    readonly sessionId: string;
}

export interface ElicitationResponseRequest {
    readonly action: SessionElicitationRespondCommand["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}

export interface PromptResult {
    readonly sessionId: string;
    readonly stopReason: string;
}

export interface FileReadResult {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly modifiedAt: string;
    readonly name: string;
}

export class MobiusClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "MobiusClientError";
    }
}

function readMessageText(event: MessageEvent<unknown>): string {
    if (typeof event.data !== "string") {
        throw new MobiusClientError("invalid_protocol_message", "Relay sent a non-text WebSocket message");
    }

    return event.data;
}

function readInboundMessage(event: MessageEvent<unknown>): string {
    const encoded = readMessageText(event);
    if (decodeMessageKind(encoded) !== SESSION_EVENT_COMMITTED_KIND) {
        return encoded;
    }
    const committed = decodeCommittedSessionEvent(encoded);
    decodeRecordedSessionEvent(committed.payload);
    return committed.payload;
}

function readInboundCommittedSequence(event: MessageEvent<unknown>): string {
    const encoded = readMessageText(event);
    if (decodeMessageKind(encoded) !== SESSION_EVENT_COMMITTED_KIND) {
        throw new MobiusClientError("invalid_protocol_message", "Relay sent an uncommitted Session event");
    }
    return decodeCommittedSessionEvent(encoded).sequence;
}

function encodeOutboundMessage(encode: () => string): string {
    try {
        return encode();
    } catch (error) {
        throw new MobiusClientError("invalid_request", "The requested operation contains invalid data", {
            cause: error,
        });
    }
}

function sendImmediately(socket: ReconnectingWebSocket, message: string): void {
    if (!socket.send(message)) {
        throw new MobiusClientError("connection_closed", "Relay connection closed before the message was sent");
    }
}

function shouldReconnectAfterClose(event: ReconnectingCloseEvent): boolean {
    return !TERMINAL_RELAY_CLOSE_CODES.has(event.code);
}

function waitForOpen(socket: ReconnectingWebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new MobiusClientError("connection_timeout", "Timed out while connecting to the relay"));
        }, CONNECTION_TIMEOUT_MILLISECONDS);

        const cleanup = (): void => {
            window.clearTimeout(timeout);
            socket.removeEventListener("close", handleClose);
            socket.removeEventListener("open", handleOpen);
        };

        const handleClose = (event: ReconnectingCloseEvent): void => {
            if (shouldReconnectAfterClose(event)) {
                return;
            }
            cleanup();
            reject(new MobiusClientError("connection_rejected", "The relay rejected the WebSocket connection"));
        };

        const handleOpen = (): void => {
            cleanup();
            resolve();
        };

        socket.addEventListener("close", handleClose);
        socket.addEventListener("open", handleOpen);
    });
}

export class MobiusClient {
    readonly #onActivity: () => void;
    readonly #onHistoryChanged: () => void;
    readonly #onProtocolError: (error: MobiusClientError) => void;
    readonly #onStatus: (online: boolean) => void;
    readonly #options: ConnectMobiusClientOptions;
    readonly #socket: ReconnectingWebSocket;

    constructor(socket: ReconnectingWebSocket, options: ConnectMobiusClientOptions) {
        this.#options = options;
        this.#onActivity = options.onActivity ?? (() => undefined);
        this.#onHistoryChanged = options.onHistoryChanged ?? (() => undefined);
        this.#onProtocolError = options.onProtocolError ?? (() => undefined);
        this.#onStatus = options.onStatus ?? (() => undefined);
        this.#socket = socket;
        this.#socket.addEventListener("message", this.#handleChannelMessage);
        this.#socket.addEventListener("close", this.#handleClose);
    }

    readonly ready = async (): Promise<void> => {
        await waitForOpen(this.#socket);
    };

    readonly listWorkspace = async (
        request: WorkspaceListRequest,
        signal: AbortSignal,
    ): Promise<WorkspaceEntriesEvent> => {
        const requestId = request.requestId ?? crypto.randomUUID();
        return await this.#requestReply(
            requestId,
            encodeOutboundMessage(() =>
                encodeWorkspaceListCommand({
                    bindingId: request.bindingId,
                    directoryId: request.directoryId,
                    kind: WORKSPACE_LIST_KIND,
                    requestId,
                }),
            ),
            WORKSPACE_ENTRIES_KIND,
            decodeWorkspaceEntriesEvent,
            (event) => event.requestId,
            signal,
        );
    };

    readonly readFile = async (
        sessionId: string,
        path: string,
        signal: AbortSignal,
        maxBytes = 32 * 1024 * 1024,
    ): Promise<FileReadResult> => {
        signal.throwIfAborted();
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The local runtime is offline");
        }
        const requestId = crypto.randomUUID();
        let cleanup = (): void => undefined;
        const result = new Promise<FileReadResult>((resolve, reject) => {
            let metadata: ReturnType<typeof decodeFileBeginEvent> | null = null;
            const chunks: Uint8Array[] = [];
            let receivedBytes = 0;
            let nextSequence = 0;
            const finish = (): void => {
                this.#socket.removeEventListener("message", handleMessage);
                this.#socket.removeEventListener("close", handleClose);
                signal.removeEventListener("abort", handleAbort);
            };
            cleanup = finish;
            const fail = (error: unknown): void => {
                finish();
                reject(error);
            };
            const handleAbort = (): void => fail(signal.reason);
            const handleClose = (): void =>
                fail(new MobiusClientError("connection_closed", "The connection closed while reading the file"));
            const handleMessage = (event: MessageEvent<unknown>): void => {
                try {
                    const encoded = readInboundMessage(event);
                    const kind = decodeMessageKind(encoded);
                    if (kind === FILE_BEGIN_KIND) {
                        const begin = decodeFileBeginEvent(encoded);
                        if (begin.requestId !== requestId) {
                            return;
                        }
                        if (begin.byteLength > maxBytes) {
                            fail(new MobiusClientError("file_too_large", "The local file is too large"));
                            return;
                        }
                        metadata = begin;
                        return;
                    }
                    if (kind === FILE_CHUNK_KIND) {
                        const chunk = decodeFileChunkEvent(encoded);
                        if (chunk.requestId !== requestId) {
                            return;
                        }
                        if (metadata === null || chunk.sequence !== nextSequence) {
                            throw new MobiusClientError("invalid_protocol_message", "File chunks are out of order");
                        }
                        const binary = atob(chunk.data);
                        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
                        receivedBytes += bytes.byteLength;
                        if (receivedBytes > metadata.byteLength || receivedBytes > maxBytes) {
                            throw new MobiusClientError(
                                "invalid_protocol_message",
                                "File exceeded its advertised size",
                            );
                        }
                        chunks.push(bytes);
                        nextSequence += 1;
                        return;
                    }
                    if (kind === FILE_END_KIND) {
                        const end = decodeFileEndEvent(encoded);
                        if (end.requestId !== requestId) {
                            return;
                        }
                        if (metadata === null || receivedBytes !== metadata.byteLength) {
                            throw new MobiusClientError("invalid_protocol_message", "File transfer was incomplete");
                        }
                        const bytes = new Uint8Array(receivedBytes);
                        let offset = 0;
                        for (const chunk of chunks) {
                            bytes.set(chunk, offset);
                            offset += chunk.byteLength;
                        }
                        finish();
                        resolve({
                            bytes,
                            mediaType: metadata.mediaType,
                            modifiedAt: metadata.modifiedAt,
                            name: metadata.name,
                        });
                        return;
                    }
                    if (kind === FILE_FAILED_KIND) {
                        const failed = decodeFileFailedEvent(encoded);
                        if (failed.requestId === requestId) {
                            fail(new MobiusClientError(failed.code, failed.message));
                        }
                    }
                } catch (error) {
                    fail(error);
                }
            };
            this.#socket.addEventListener("message", handleMessage);
            this.#socket.addEventListener("close", handleClose, { once: true });
            signal.addEventListener("abort", handleAbort, { once: true });
        });
        try {
            sendImmediately(
                this.#socket,
                encodeOutboundMessage(() =>
                    encodeFileReadCommand({
                        kind: FILE_READ_KIND,
                        maxBytes,
                        path,
                        requestId,
                        sessionId,
                    }),
                ),
            );
        } catch (error) {
            cleanup();
            throw error;
        }
        return await result;
    };

    readonly prepareSession = async (
        request: SessionPrepareRequest,
        signal: AbortSignal,
    ): Promise<SessionReadyEvent> => {
        const requestId = request.requestId ?? crypto.randomUUID();
        return await this.#requestReply(
            requestId,
            encodeOutboundMessage(() =>
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: request.additionalDirectoryIds,
                    agentId: request.agentId,
                    bindingId: request.bindingId,
                    directoryId: request.directoryId,
                    kind: SESSION_PREPARE_KIND,
                    requestId,
                    sessionId: request.sessionId,
                    ...(request.transient === true ? { transient: true } : {}),
                }),
            ),
            SESSION_READY_KIND,
            decodeSessionReadyEvent,
            (event) => event.requestId,
            signal,
        );
    };

    readonly manageNativeSession = async (
        command: NativeSessionRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        return await this.#requestReply(
            command.requestId,
            encodeOutboundMessage(() => encodeNativeSessionRequest(command)),
            NATIVE_SESSION_RESULT_KIND,
            decodeNativeSessionResult,
            (event) => event.requestId,
            signal,
            () => {
                try {
                    if (this.#socket.readyState === WebSocket.OPEN) {
                        sendImmediately(
                            this.#socket,
                            encodeNativeSessionCancel({
                                kind: NATIVE_SESSION_CANCEL_KIND,
                                requestId: command.requestId,
                                sessionId: command.sessionId,
                            }),
                        );
                    }
                } catch {
                    // The local runtime also cancels requests when the connection closes.
                }
            },
        );
    };

    readonly forkSessionTurn = async (
        command: NativeSessionTurnForkRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        return await this.#requestReply(
            command.requestId,
            encodeOutboundMessage(() => encodeNativeSessionTurnForkRequest(command)),
            NATIVE_SESSION_RESULT_KIND,
            decodeNativeSessionResult,
            (event) => event.requestId,
            signal,
            () => {
                try {
                    if (this.#socket.readyState === WebSocket.OPEN) {
                        sendImmediately(
                            this.#socket,
                            encodeNativeSessionCancel({
                                kind: NATIVE_SESSION_CANCEL_KIND,
                                requestId: command.requestId,
                                sessionId: command.sessionId,
                            }),
                        );
                    }
                } catch {
                    // The local runtime also cancels requests when the connection closes.
                }
            },
        );
    };

    readonly configureSession = async (
        request: SessionConfigureRequest,
        signal: AbortSignal,
    ): Promise<SessionConfigUpdatedEvent> => {
        const requestId = request.requestId ?? crypto.randomUUID();
        return await this.#requestReply(
            requestId,
            encodeOutboundMessage(() =>
                encodeSessionConfigureCommand({
                    additionalDirectoryIds: request.additionalDirectoryIds,
                    agentId: request.agentId,
                    bindingId: request.bindingId,
                    booleanValue: request.booleanValue,
                    configId: request.configId,
                    directoryId: request.directoryId,
                    kind: SESSION_CONFIGURE_KIND,
                    requestId,
                    sessionId: request.sessionId,
                    value: request.value,
                    valueType: request.valueType,
                }),
            ),
            SESSION_CONFIG_UPDATED_KIND,
            decodeSessionConfigUpdatedEvent,
            (event) => event.requestId,
            signal,
        );
    };

    readonly respondPermission = async (request: PermissionResponseRequest): Promise<SessionPermissionResolvedEvent> =>
        await this.#requestReply(
            request.interactionId,
            encodeOutboundMessage(() =>
                encodeSessionPermissionRespondCommand({
                    interactionId: request.interactionId,
                    kind: SESSION_PERMISSION_RESPOND_KIND,
                    optionId: request.optionId,
                    outcome: request.outcome,
                    sessionId: request.sessionId,
                }),
            ),
            SESSION_PERMISSION_RESOLVED_KIND,
            decodeSessionPermissionResolvedEvent,
            (event) => event.interactionId,
        );

    readonly respondElicitation = async (
        request: ElicitationResponseRequest,
    ): Promise<SessionElicitationResolvedEvent> =>
        await this.#requestReply(
            request.interactionId,
            encodeOutboundMessage(() =>
                encodeSessionElicitationRespondCommand({
                    action: request.action,
                    content: request.content,
                    interactionId: request.interactionId,
                    kind: SESSION_ELICITATION_RESPOND_KIND,
                    sessionId: request.sessionId,
                }),
            ),
            SESSION_ELICITATION_RESOLVED_KIND,
            decodeSessionElicitationResolvedEvent,
            (event) => event.interactionId,
        );

    readonly cancel = (request: CancelRequest): void => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }
        try {
            sendImmediately(
                this.#socket,
                encodeOutboundMessage(() =>
                    encodeSessionCancelCommand({
                        commandId: request.commandId,
                        kind: SESSION_CANCEL_KIND,
                        sessionId: request.sessionId,
                    }),
                ),
            );
        } catch (error) {
            throw new MobiusClientError("connection_closed", "Could not send cancellation to the relay", {
                cause: error,
            });
        }
    };

    readonly cancelAgentInstallation = (request: AgentInstallCancelRequest): void => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }
        try {
            sendImmediately(
                this.#socket,
                encodeOutboundMessage(() =>
                    encodeAgentInstallCancelCommand({
                        kind: AGENT_INSTALL_CANCEL_KIND,
                        requestId: request.requestId,
                    }),
                ),
            );
        } catch (error) {
            throw new MobiusClientError(
                "connection_closed",
                "Could not send Agent installation cancellation to the relay",
                { cause: error },
            );
        }
    };

    readonly installAgent = async (request: AgentInstallRequest): Promise<AgentInstallCompletedEvent> => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }
        const requestId = request.requestId ?? crypto.randomUUID();
        let cleanupInstallation = (): void => undefined;
        const result = new Promise<AgentInstallCompletedEvent>((resolveInstallation, rejectInstallation) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                rejectInstallation(
                    new MobiusClientError(
                        "installation_timeout",
                        "Timed out while waiting for the local Agent installation",
                    ),
                );
            }, INSTALLATION_TIMEOUT_MILLISECONDS);
            const cleanup = (): void => {
                window.clearTimeout(timeout);
                this.#socket.removeEventListener("message", handleMessage);
                this.#socket.removeEventListener("close", handleClose);
            };
            cleanupInstallation = cleanup;
            const handleClose = (): void => {
                cleanup();
                rejectInstallation(
                    new MobiusClientError(
                        "connection_closed",
                        "Relay connection closed while Agent installation was running",
                    ),
                );
            };
            const handleMessage = (message: MessageEvent<unknown>): void => {
                try {
                    const encoded = readInboundMessage(message);
                    const kind = decodeMessageKind(encoded);
                    if (kind === AGENT_INSTALL_COMPLETED_KIND) {
                        const completed = decodeAgentInstallCompletedEvent(encoded);
                        if (completed.requestId === requestId) {
                            cleanup();
                            resolveInstallation(completed);
                        }
                        return;
                    }
                    if (kind === AGENT_INSTALL_FAILED_KIND) {
                        const failed = decodeAgentInstallFailedEvent(encoded);
                        if (failed.requestId === requestId) {
                            cleanup();
                            rejectInstallation(new MobiusClientError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind === AGENT_INSTALL_CANCELLED_KIND) {
                        const cancelled = decodeAgentInstallCancelledEvent(encoded);
                        if (cancelled.requestId === requestId) {
                            cleanup();
                            rejectInstallation(
                                new MobiusClientError(
                                    "installation_cancelled",
                                    "The local Agent installation was cancelled",
                                ),
                            );
                        }
                        return;
                    }
                    if (kind === SESSION_OPERATION_FAILED_KIND) {
                        const failed = decodeSessionOperationFailedEvent(encoded);
                        if (failed.requestId === requestId) {
                            cleanup();
                            rejectInstallation(new MobiusClientError(failed.code, failed.message));
                        }
                    }
                } catch (error) {
                    cleanup();
                    rejectInstallation(
                        new MobiusClientError(
                            "invalid_protocol_message",
                            "Received an invalid Agent installation message",
                            { cause: error },
                        ),
                    );
                }
            };
            this.#socket.addEventListener("message", handleMessage);
            this.#socket.addEventListener("close", handleClose, { once: true });
        });
        try {
            sendImmediately(
                this.#socket,
                encodeOutboundMessage(() =>
                    encodeAgentInstallRequestCommand({
                        agentId: request.agentId,
                        kind: AGENT_INSTALL_REQUEST_KIND,
                        requestId,
                    }),
                ),
            );
        } catch (error) {
            cleanupInstallation();
            throw new MobiusClientError(
                "connection_closed",
                "Could not send the Agent installation request to the relay",
                { cause: error },
            );
        }
        return await result;
    };

    readonly prompt = async (request: PromptRequest): Promise<PromptResult> => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }

        const commandId = request.commandId ?? crypto.randomUUID();
        const sessionId = request.sessionId ?? crypto.randomUUID();
        const outbound = encodeOutboundMessage(() =>
            encodeSessionPromptCommand({
                additionalDirectoryIds: request.additionalDirectoryIds ?? [],
                agentId: request.agentId,
                bindingId: request.bindingId,
                commandId,
                directoryId: request.directoryId ?? "default",
                disposition: request.disposition ?? SessionPromptDisposition.Reject,
                images: request.images ?? [],
                kind: SESSION_PROMPT_KIND,
                prompt: request.prompt,
                resources: request.resources ?? [],
                ...(request.sessionConfigurations === undefined
                    ? {}
                    : { sessionConfigurations: request.sessionConfigurations }),
                sessionId,
                targetCommandId: request.targetCommandId ?? "",
            }),
        );
        let cleanupPrompt = (): void => undefined;

        const result = new Promise<PromptResult>((resolve, reject) => {
            const cleanup = (): void => {
                this.#socket.removeEventListener("message", handleMessage);
                this.#socket.removeEventListener("close", handleSocketClose);
            };
            cleanupPrompt = cleanup;

            const handleSocketClose = (): void => {
                cleanup();
                reject(
                    new MobiusClientError("connection_closed", "Relay connection closed while the request was running"),
                );
            };

            const handleMessage = (event: MessageEvent<unknown>): void => {
                try {
                    const encoded = readInboundMessage(event);
                    const kind = decodeMessageKind(encoded);

                    if (kind === SESSION_STARTED_KIND) {
                        const message = decodeSessionStartedEvent(encoded);
                        if (message.commandId === commandId) {
                            request.observer?.onStarted?.(message.attemptId);
                        }
                        return;
                    }

                    if (kind === AGENT_MESSAGE_DELTA_KIND) {
                        const message = decodeAgentMessageDeltaEvent(encoded);
                        if (message.commandId === commandId) {
                            request.observer?.onDelta?.(message.text, readInboundCommittedSequence(event));
                        }
                        return;
                    }

                    if (kind === AGENT_ACTIVITY_KIND) {
                        const message = decodeAgentActivityEvent(encoded);
                        if (message.commandId === commandId) {
                            request.observer?.onActivity?.(message);
                        }
                        return;
                    }

                    if (kind === AGENT_ACTIVITY_NARRATION_KIND) {
                        const message = decodeAgentActivityNarrationEvent(encoded);
                        if (message.commandId === commandId) {
                            request.observer?.onNarration?.(message);
                        }
                        return;
                    }

                    if (kind === AGENT_CONTENT_KIND) {
                        const message = decodeAgentContentEvent(encoded);
                        if (message.commandId === commandId) {
                            request.observer?.onContent?.(message);
                        }
                        return;
                    }

                    if (kind === SESSION_COMPLETED_KIND) {
                        const message = decodeSessionCompletedEvent(encoded);
                        if (message.commandId === commandId) {
                            cleanup();
                            resolve({
                                sessionId: message.sessionId,
                                stopReason: message.stopReason,
                            });
                        }
                        return;
                    }

                    if (kind === SESSION_FAILED_KIND) {
                        const message = decodeSessionFailedEvent(encoded);
                        if (message.commandId === commandId) {
                            cleanup();
                            reject(new MobiusClientError(message.code, message.message));
                        }
                    }
                } catch (error) {
                    cleanup();
                    reject(
                        new MobiusClientError(
                            "invalid_protocol_message",
                            "Received an invalid message from the relay",
                            { cause: error },
                        ),
                    );
                }
            };

            this.#socket.addEventListener("message", handleMessage);
            this.#socket.addEventListener("close", handleSocketClose, { once: true });
        });

        try {
            sendImmediately(this.#socket, outbound);
        } catch (error) {
            cleanupPrompt();
            throw new MobiusClientError("connection_closed", "Could not send the request to the relay", {
                cause: error,
            });
        }

        return result;
    };

    readonly #requestReply = async <T>(
        requestId: string,
        outbound: string,
        expectedKind: string,
        decode: (encoded: string) => T,
        identify: (event: T) => string,
        signal?: AbortSignal,
        cancel?: () => void,
    ): Promise<T> => {
        signal?.throwIfAborted();
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }
        let cleanupRequest = (): void => undefined;
        const result = new Promise<T>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                cancel?.();
                reject(new MobiusClientError("operation_timeout", "Timed out while waiting for the local runtime"));
            }, OPERATION_TIMEOUT_MILLISECONDS);
            const cleanup = (): void => {
                window.clearTimeout(timeout);
                this.#socket.removeEventListener("message", handleMessage);
                this.#socket.removeEventListener("close", handleClose);
                signal?.removeEventListener("abort", handleAbort);
            };
            const handleAbort = (): void => {
                cleanup();
                cancel?.();
                reject(
                    signal?.reason ??
                        new MobiusClientError("operation_cancelled", "Native session operation cancelled"),
                );
            };
            cleanupRequest = cleanup;
            const handleClose = (): void => {
                cleanup();
                reject(
                    new MobiusClientError(
                        "connection_closed",
                        "Relay connection closed while the operation was running",
                    ),
                );
            };
            const handleMessage = (message: MessageEvent<unknown>): void => {
                try {
                    const encoded = readInboundMessage(message);
                    const kind = decodeMessageKind(encoded);
                    if (kind === SESSION_OPERATION_FAILED_KIND) {
                        const failure = decodeSessionOperationFailedEvent(encoded);
                        if (failure.requestId === requestId) {
                            cleanup();
                            reject(new MobiusClientError(failure.code, failure.message));
                        }
                        return;
                    }
                    if (kind !== expectedKind) {
                        return;
                    }
                    const event = decode(encoded);
                    if (identify(event) === requestId) {
                        cleanup();
                        resolve(event);
                    }
                } catch (error) {
                    cleanup();
                    reject(
                        new MobiusClientError(
                            "invalid_protocol_message",
                            "Received an invalid message from the relay",
                            { cause: error },
                        ),
                    );
                }
            };
            this.#socket.addEventListener("message", handleMessage);
            this.#socket.addEventListener("close", handleClose, { once: true });
            signal?.addEventListener("abort", handleAbort, { once: true });
        });
        try {
            sendImmediately(this.#socket, outbound);
        } catch (error) {
            cleanupRequest();
            throw new MobiusClientError("connection_closed", "Could not send the operation to the relay", {
                cause: error,
            });
        }
        return await result;
    };

    readonly close = (): void => {
        this.#socket.removeEventListener("message", this.#handleChannelMessage);
        this.#socket.removeEventListener("close", this.#handleClose);
        this.#socket.close(1000, "Host closed");
    };

    readonly #handleClose = (event: ReconnectingCloseEvent): void => {
        if (shouldReconnectAfterClose(event)) {
            this.#options.onReconnecting?.();
            return;
        }
        this.#options.onUnavailable?.();
    };

    readonly #handleChannelMessage = (event: MessageEvent<unknown>): void => {
        try {
            const encoded = readInboundMessage(event);
            const kind = decodeMessageKind(encoded);
            if (kind === RUNTIME_STATUS_KIND) {
                this.#onStatus(decodeRuntimeStatusEvent(encoded).online);
                return;
            }
            if (kind === SESSION_PROMPT_KIND) {
                decodeSessionPromptCommand(encoded);
            } else if (kind === NATIVE_SESSION_REQUEST_KIND) {
                decodeNativeSessionCommand(encoded);
            } else if (kind === NATIVE_SESSION_TURN_FORK_REQUEST_KIND) {
                decodeNativeSessionTurnForkRequest(encoded);
            } else if (kind === NATIVE_SESSION_CANCEL_KIND) {
                decodeNativeSessionCancel(encoded);
            } else if (kind === NATIVE_SESSION_RESULT_KIND) {
                this.#options.onNativeSessionResult?.(decodeNativeSessionResult(encoded));
            } else if (kind === SESSION_CANCEL_KIND) {
                decodeSessionCancelCommand(encoded);
            } else if (kind === WORKSPACE_LIST_KIND) {
                decodeWorkspaceListCommand(encoded);
            } else if (kind === WORKSPACE_ENTRIES_KIND) {
                this.#options.onWorkspace?.(decodeWorkspaceEntriesEvent(encoded));
            } else if (kind === FILE_READ_KIND) {
                // The Relay echoes host control requests to sibling tabs.
            } else if (kind === FILE_BEGIN_KIND) {
                decodeFileBeginEvent(encoded);
            } else if (kind === FILE_CHUNK_KIND) {
                decodeFileChunkEvent(encoded);
            } else if (kind === FILE_END_KIND) {
                decodeFileEndEvent(encoded);
            } else if (kind === FILE_FAILED_KIND) {
                decodeFileFailedEvent(encoded);
            } else if (kind === SESSION_PREPARE_KIND) {
                decodeSessionPrepareCommand(encoded);
            } else if (kind === SESSION_READY_KIND) {
                this.#options.onReady?.(decodeSessionReadyEvent(encoded));
            } else if (kind === SESSION_CONFIGURE_KIND) {
                decodeSessionConfigureCommand(encoded);
            } else if (kind === SESSION_CONFIG_UPDATED_KIND) {
                this.#options.onConfig?.(decodeSessionConfigUpdatedEvent(encoded));
            } else if (kind === SESSION_COMMANDS_UPDATED_KIND) {
                this.#options.onCommands?.(decodeSessionCommandsUpdatedEvent(encoded));
            } else if (kind === SESSION_INFO_UPDATED_KIND) {
                this.#options.onInfo?.(decodeSessionInfoUpdatedEvent(encoded));
            } else if (kind === SESSION_USAGE_UPDATED_KIND) {
                this.#options.onUsage?.(decodeSessionUsageUpdatedEvent(encoded));
            } else if (kind === SESSION_PERMISSION_REQUESTED_KIND) {
                this.#options.onPermission?.(decodeSessionPermissionRequestedEvent(encoded));
            } else if (kind === SESSION_PERMISSION_RESPOND_KIND) {
                decodeSessionPermissionRespondCommand(encoded);
            } else if (kind === SESSION_PERMISSION_RESOLVED_KIND) {
                this.#options.onPermissionResolved?.(decodeSessionPermissionResolvedEvent(encoded));
            } else if (kind === SESSION_ELICITATION_REQUESTED_KIND) {
                this.#options.onElicitation?.(decodeSessionElicitationRequestedEvent(encoded));
            } else if (kind === SESSION_ELICITATION_RESPOND_KIND) {
                decodeSessionElicitationRespondCommand(encoded);
            } else if (kind === SESSION_ELICITATION_RESOLVED_KIND) {
                this.#options.onElicitationResolved?.(decodeSessionElicitationResolvedEvent(encoded));
            } else if (kind === SESSION_STARTED_KIND) {
                decodeSessionStartedEvent(encoded);
            } else if (kind === AGENT_MESSAGE_DELTA_KIND) {
                decodeAgentMessageDeltaEvent(encoded);
            } else if (kind === AGENT_ACTIVITY_KIND) {
                decodeAgentActivityEvent(encoded);
            } else if (kind === AGENT_ACTIVITY_NARRATION_KIND) {
                decodeAgentActivityNarrationEvent(encoded);
            } else if (kind === AGENT_CONTENT_KIND) {
                this.#options.onContent?.(decodeAgentContentEvent(encoded));
            } else if (kind === AGENT_INSTALL_REQUEST_KIND) {
                decodeAgentInstallRequestCommand(encoded);
            } else if (kind === AGENT_INSTALL_CANCEL_KIND) {
                decodeAgentInstallCancelCommand(encoded);
            } else if (kind === AGENT_INSTALL_STARTED_KIND) {
                this.#options.onInstallStarted?.(decodeAgentInstallStartedEvent(encoded));
            } else if (kind === AGENT_INSTALL_PROGRESS_KIND) {
                this.#options.onInstallProgress?.(decodeAgentInstallProgressEvent(encoded));
            } else if (kind === AGENT_INSTALL_COMPLETED_KIND) {
                this.#options.onInstallCompleted?.(decodeAgentInstallCompletedEvent(encoded));
            } else if (kind === AGENT_INSTALL_FAILED_KIND) {
                this.#options.onInstallFailed?.(decodeAgentInstallFailedEvent(encoded));
            } else if (kind === AGENT_INSTALL_CANCELLED_KIND) {
                this.#options.onInstallCancelled?.(decodeAgentInstallCancelledEvent(encoded));
            } else if (kind === SESSION_COMPLETED_KIND) {
                decodeSessionCompletedEvent(encoded);
            } else if (kind === SESSION_FAILED_KIND) {
                decodeSessionFailedEvent(encoded);
            } else if (kind === SESSION_OPERATION_FAILED_KIND) {
                decodeSessionOperationFailedEvent(encoded);
            } else {
                throw new MobiusClientError("invalid_protocol_message", "Relay sent an unsupported message kind");
            }
            this.#onActivity();
            if (HISTORY_CHANGING_MESSAGE_KINDS.has(kind)) {
                this.#onHistoryChanged();
            }
        } catch (error) {
            this.#onProtocolError(
                new MobiusClientError("invalid_protocol_message", "Received an invalid message from the relay", {
                    cause: error,
                }),
            );
        }
    };
}

export async function connectMobiusClient(options: ConnectMobiusClientOptions): Promise<MobiusClient> {
    const socket = new ReconnectingWebSocket(options.relayUrl, [...(options.protocols ?? [])], {
        connectionTimeout: CONNECTION_TIMEOUT_MILLISECONDS,
        maxEnqueuedMessages: 0,
        maxReconnectionDelay: MAX_RECONNECTION_DELAY_MILLISECONDS,
        minReconnectionDelay: MIN_RECONNECTION_DELAY_MILLISECONDS * (1 + Math.random()),
        shouldReconnectOnClose: shouldReconnectAfterClose,
    });
    const client = new MobiusClient(socket, options);

    try {
        await client.ready();
        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}
