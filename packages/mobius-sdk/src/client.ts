import {
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    type AgentInstallCancelledEvent,
    type AgentInstallCompletedEvent,
    type AgentInstallFailedEvent,
    type AgentInstallProgressEvent,
    type AgentInstallStartedEvent,
    decodeAgentInstallCancelledEvent,
    decodeAgentInstallCompletedEvent,
    decodeAgentInstallFailedEvent,
    decodeAgentInstallProgressEvent,
    decodeAgentInstallStartedEvent,
    decodeDaemonToServiceMessage,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionHistoryPageLoadedV3,
    decodeSessionLiveEventEnvelopeV3,
    decodeSessionOperationFailedEvent,
    encodeAgentInstallCancelCommand,
    encodeAgentInstallRequestCommand,
    encodeSessionHistoryPageLoadV3,
    RUNTIME_STATUS_KIND,
    SESSION_HISTORY_V3_PAGE_LOADED_KIND,
    SESSION_LIVE_V3_KIND,
    SESSION_OPERATION_FAILED_KIND,
    type SessionElicitationRespondCommand,
    type SessionHistoryPageRequestV3,
    type SessionHistoryPageV3,
    type SessionLiveEventV3,
    type SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-protocol";
import ReconnectingWebSocket, { type CloseEvent as ReconnectingCloseEvent } from "partysocket/ws";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const MAX_RECONNECTION_DELAY_MILLISECONDS = 10_000;
const MIN_RECONNECTION_DELAY_MILLISECONDS = 500;
const INSTALLATION_TIMEOUT_MILLISECONDS = 11 * 60 * 1_000;
const SESSION_OPERATION_TIMEOUT_MILLISECONDS = 45_000;
const TERMINAL_RELAY_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1003, 1007, 1008, 4003, 4008]);
export type MobiusRelayUrlProvider = (signal: AbortSignal) => Promise<string>;

export interface ConnectMobiusClientOptions {
    readonly protocols?: readonly string[];
    readonly onInstallCancelled?: (event: AgentInstallCancelledEvent) => void;
    readonly onInstallCompleted?: (event: AgentInstallCompletedEvent) => void;
    readonly onInstallFailed?: (event: AgentInstallFailedEvent) => void;
    readonly onInstallProgress?: (event: AgentInstallProgressEvent) => void;
    readonly onInstallStarted?: (event: AgentInstallStartedEvent) => void;
    readonly onProtocolError?: (error: MobiusClientError) => void;
    readonly onSessionLiveV3?: (events: readonly SessionLiveEventV3[]) => void;
    readonly onReconnecting?: () => void;
    readonly onStatus?: (online: boolean) => void;
    readonly onUnavailable?: () => void;
    readonly relayUrl: string | MobiusRelayUrlProvider;
}

export interface AgentInstallRequest {
    readonly agentId: string;
    readonly requestId?: string;
}

export interface AgentInstallCancelRequest {
    readonly requestId: string;
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
    readonly #connectionController: AbortController | null;
    readonly #onProtocolError: (error: MobiusClientError) => void;
    readonly #onStatus: (online: boolean) => void;
    readonly #options: ConnectMobiusClientOptions;
    readonly #socket: ReconnectingWebSocket;

    constructor(
        socket: ReconnectingWebSocket,
        options: ConnectMobiusClientOptions,
        connectionController: AbortController | null = null,
    ) {
        this.#connectionController = connectionController;
        this.#options = options;
        this.#onProtocolError = options.onProtocolError ?? (() => undefined);
        this.#onStatus = options.onStatus ?? (() => undefined);
        this.#socket = socket;
        this.#socket.addEventListener("message", this.#handleChannelMessage);
        this.#socket.addEventListener("close", this.#handleClose);
    }

    readonly ready = async (): Promise<void> => {
        await waitForOpen(this.#socket);
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
                    const encoded = readMessageText(message);
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

    readonly loadSessionHistoryV3 = async (
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<SessionHistoryPageV3> => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            throw new MobiusClientError("runtime_offline", "The relay connection is not open");
        }
        signal.throwIfAborted();
        const requestId = crypto.randomUUID();
        const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(SESSION_OPERATION_TIMEOUT_MILLISECONDS)]);
        let cleanupOperation = (): void => undefined;
        const result = new Promise<SessionHistoryPageV3>((resolve, reject) => {
            const cleanup = (): void => {
                operationSignal.removeEventListener("abort", handleAbort);
                this.#socket.removeEventListener("close", handleClose);
                this.#socket.removeEventListener("message", handleMessage);
            };
            cleanupOperation = cleanup;
            const handleAbort = (): void => {
                cleanup();
                reject(new MobiusClientError("operation_cancelled", "The Session history request was cancelled"));
            };
            const handleClose = (): void => {
                cleanup();
                reject(
                    new MobiusClientError("connection_closed", "Relay connection closed while loading Session history"),
                );
            };
            const handleMessage = (message: MessageEvent<unknown>): void => {
                try {
                    const encoded = readMessageText(message);
                    const kind = decodeMessageKind(encoded);
                    if (kind === SESSION_HISTORY_V3_PAGE_LOADED_KIND) {
                        const loaded = decodeSessionHistoryPageLoadedV3(encoded);
                        if (loaded.requestId === requestId && loaded.sessionId === request.sessionId) {
                            cleanup();
                            resolve(loaded.page);
                        }
                        return;
                    }
                    if (kind === SESSION_OPERATION_FAILED_KIND) {
                        const failed = decodeSessionOperationFailedEvent(encoded);
                        if (failed.requestId === requestId) {
                            cleanup();
                            reject(new MobiusClientError(failed.code, failed.message));
                        }
                    }
                } catch (cause) {
                    cleanup();
                    reject(
                        new MobiusClientError("invalid_protocol_message", "Received invalid V3 Session history", {
                            cause,
                        }),
                    );
                }
            };
            operationSignal.addEventListener("abort", handleAbort, { once: true });
            this.#socket.addEventListener("close", handleClose, { once: true });
            this.#socket.addEventListener("message", handleMessage);
        });
        try {
            sendImmediately(
                this.#socket,
                encodeOutboundMessage(() =>
                    encodeSessionHistoryPageLoadV3({
                        ...request,
                        kind: "session.history.v3.page.load",
                        requestId,
                    }),
                ),
            );
        } catch (cause) {
            cleanupOperation();
            throw new MobiusClientError("connection_closed", "Could not send the V3 Session history request", {
                cause,
            });
        }
        return await result;
    };

    readonly close = (): void => {
        this.#connectionController?.abort(
            new MobiusClientError("connection_closed", "The browser relay connection was closed"),
        );
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
            const encoded = readMessageText(event);
            const kind = decodeMessageKind(encoded);
            if (kind === RUNTIME_STATUS_KIND) {
                this.#onStatus(decodeRuntimeStatusEvent(encoded).online);
                return;
            }
            if (kind === SESSION_LIVE_V3_KIND) {
                this.#options.onSessionLiveV3?.(decodeSessionLiveEventEnvelopeV3(encoded).events);
                return;
            }
            if (kind === AGENT_INSTALL_STARTED_KIND) {
                this.#options.onInstallStarted?.(decodeAgentInstallStartedEvent(encoded));
            } else if (kind === AGENT_INSTALL_PROGRESS_KIND) {
                this.#options.onInstallProgress?.(decodeAgentInstallProgressEvent(encoded));
            } else if (kind === AGENT_INSTALL_COMPLETED_KIND) {
                this.#options.onInstallCompleted?.(decodeAgentInstallCompletedEvent(encoded));
            } else if (kind === AGENT_INSTALL_FAILED_KIND) {
                this.#options.onInstallFailed?.(decodeAgentInstallFailedEvent(encoded));
            } else if (kind === AGENT_INSTALL_CANCELLED_KIND) {
                this.#options.onInstallCancelled?.(decodeAgentInstallCancelledEvent(encoded));
            } else {
                decodeDaemonToServiceMessage(encoded);
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
    const connectionController = new AbortController();
    const configuredRelayUrl = options.relayUrl;
    const relayUrl =
        typeof configuredRelayUrl === "string"
            ? configuredRelayUrl
            : async (): Promise<string> => await configuredRelayUrl(connectionController.signal);
    const socket = new ReconnectingWebSocket(relayUrl, [...(options.protocols ?? [])], {
        connectionTimeout: CONNECTION_TIMEOUT_MILLISECONDS,
        maxEnqueuedMessages: 0,
        maxReconnectionDelay: MAX_RECONNECTION_DELAY_MILLISECONDS,
        minReconnectionDelay: MIN_RECONNECTION_DELAY_MILLISECONDS * (1 + Math.random()),
        shouldReconnectOnClose: shouldReconnectAfterClose,
    });
    const client = new MobiusClient(socket, options, connectionController);

    try {
        await client.ready();
        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}
