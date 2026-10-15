import {
    decodeDaemonToServiceMessage,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    RUNTIME_STATUS_KIND,
    type SessionElicitationRespondCommand,
    type SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-protocol";
import ReconnectingWebSocket, { type CloseEvent as ReconnectingCloseEvent } from "partysocket/ws";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const MAX_RECONNECTION_DELAY_MILLISECONDS = 10_000;
const MIN_RECONNECTION_DELAY_MILLISECONDS = 500;
const TERMINAL_RELAY_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1003, 1007, 1008, 4003, 4008]);
export type MobiusRelayUrlProvider = (signal: AbortSignal) => Promise<string>;

export interface ConnectMobiusClientOptions {
    readonly protocols?: readonly string[];
    readonly onProtocolError?: (error: MobiusClientError) => void;
    readonly onReconnecting?: () => void;
    readonly onStatus?: (online: boolean) => void;
    readonly onUnavailable?: () => void;
    readonly relayUrl: string | MobiusRelayUrlProvider;
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
            decodeDaemonToServiceMessage(encoded);
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
