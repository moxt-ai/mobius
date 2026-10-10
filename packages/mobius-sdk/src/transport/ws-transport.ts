import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { fromByteArray, toByteArray } from "base64-js";
import { MobiusApiError, MobiusConnectionError, MobiusProtocolError, MobiusValidationError } from "../errors.ts";
import type { MobiusHttpTransport, MobiusTransportSessionEvent } from "./http-transport.ts";

const DEFAULT_CONNECTION_TIMEOUT_MILLISECONDS = 15_000;

export interface MobiusWebSocketConnector {
    readonly connect: (endpoint: URL, signal: AbortSignal) => Promise<WebSocket>;
}

export interface WsTransportOptions {
    readonly connectionTimeoutMilliseconds?: number;
    readonly connector?: MobiusWebSocketConnector;
    readonly idleTimeoutMilliseconds?: number;
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

type WsTransportState =
    | { readonly kind: "closed" }
    | {
          readonly kind: "connected";
          readonly idleTimeoutId: ReturnType<typeof globalThis.setTimeout>;
          readonly socket: WebSocket;
      }
    | { readonly kind: "connecting"; readonly connection: Promise<WebSocket> }
    | { readonly kind: "disconnected" };

type PendingWsRequest = {
    readonly reject: (cause: unknown) => void;
    readonly resolve: (response: Response) => void;
};
type LiveEventSubscription =
    | {
          readonly cleanup: () => void;
          readonly kind: "opening";
          readonly reject: (cause: unknown) => void;
          readonly resolve: (events: ReadableStream<MobiusTransportSessionEvent>) => void;
      }
    | {
          readonly cleanup: () => void;
          readonly controller: ReadableStreamDefaultController<MobiusTransportSessionEvent>;
          readonly kind: "open";
      };

const WS_REQUEST_KIND = "http.request";
const WS_RESPONSE_KIND = "http.response";
const WS_ERROR_KIND = "http.error";
const EVENT_SUBSCRIBE_KIND = "session.events.subscribe";
const EVENT_UNSUBSCRIBE_KIND = "session.events.unsubscribe";
const SAFE_WEBSOCKET_CLOSE_REASONS = new Set(["WebSocket transport closed", "WebSocket transport idle timeout"]);

function webSocketCloseError(event: CloseEvent, action: "connect" | "remain connected"): MobiusConnectionError {
    const reason = SAFE_WEBSOCKET_CLOSE_REASONS.has(event.reason) ? `: ${event.reason}` : "";
    return new MobiusConnectionError(`The Mobius WebSocket could not ${action} (close code ${event.code}${reason})`);
}

function bytesToBase64(bytes: Uint8Array): string {
    return fromByteArray(bytes);
}

function base64ToBytes(encoded: string): ArrayBuffer {
    const decoded = toByteArray(encoded);
    const buffer = new ArrayBuffer(decoded.byteLength);
    new Uint8Array(buffer).set(decoded);
    return buffer;
}

function wsRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MobiusProtocolError("The WebSocket transport returned an invalid message");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function wsString(value: Readonly<Record<string, unknown>>, field: string, maximum: number): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw new MobiusProtocolError("The WebSocket transport returned an invalid message");
    }
    return candidate;
}

function wsHeaders(value: unknown): Headers {
    if (!Array.isArray(value) || value.length > 128) {
        throw new MobiusProtocolError("The WebSocket transport returned invalid response headers");
    }
    const headers = new Headers();
    for (const entry of value) {
        if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            typeof entry[1] !== "string" ||
            entry[0].length > 256 ||
            entry[1].length > 16_384
        ) {
            throw new MobiusProtocolError("The WebSocket transport returned invalid response headers");
        }
        headers.append(entry[0], entry[1]);
    }
    return headers;
}

class PlatformMobiusWebSocketConnector implements MobiusWebSocketConnector {
    readonly connect = async (endpoint: URL, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        const socket = new WebSocket(endpoint.toString());
        return await new Promise<WebSocket>((resolve, reject) => {
            let completed = false;
            const cleanup = (): void => {
                signal.removeEventListener("abort", abort);
                socket.removeEventListener("close", close);
                socket.removeEventListener("error", error);
                socket.removeEventListener("open", open);
            };
            const fail = (cause: unknown): void => {
                if (completed) {
                    return;
                }
                completed = true;
                cleanup();
                socket.close();
                reject(cause);
            };
            const abort = (): void => fail(signal.reason);
            const close = (event: CloseEvent): void => fail(webSocketCloseError(event, "connect"));
            const error = (): void =>
                fail(new MobiusConnectionError("The browser reported an error while connecting the Mobius WebSocket"));
            const open = (): void => {
                if (completed) {
                    return;
                }
                completed = true;
                cleanup();
                resolve(socket);
            };
            signal.addEventListener("abort", abort, { once: true });
            socket.addEventListener("close", close, { once: true });
            socket.addEventListener("error", error, { once: true });
            socket.addEventListener("open", open, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
    };
}

export class WsTransport implements MobiusHttpTransport {
    readonly #connectionTimeoutMilliseconds: number;
    readonly #connector: MobiusWebSocketConnector;
    readonly #idleTimeoutMilliseconds: number;
    readonly #pending = new Map<string, PendingWsRequest>();
    readonly #subscriptions = new Map<string, LiveEventSubscription>();
    #origin: string | null = null;
    #state: WsTransportState = { kind: "disconnected" };

    constructor(options: WsTransportOptions = {}) {
        this.#connectionTimeoutMilliseconds = validatePositiveInteger(
            options.connectionTimeoutMilliseconds ?? DEFAULT_CONNECTION_TIMEOUT_MILLISECONDS,
            "WebSocket transport connection timeout",
        );
        this.#connector = options.connector ?? new PlatformMobiusWebSocketConnector();
        this.#idleTimeoutMilliseconds = validatePositiveInteger(
            options.idleTimeoutMilliseconds ?? 60_000,
            "WebSocket transport idle timeout",
        );
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        request.signal.throwIfAborted();
        const requestUrl = new URL(request.url);
        if (this.#origin !== null && this.#origin !== requestUrl.origin) {
            throw new MobiusValidationError("A WebSocket transport cannot connect to multiple Mobius origins");
        }
        this.#origin = requestUrl.origin;
        const socket = await this.#socket(requestUrl);
        request.signal.throwIfAborted();
        request.signal.throwIfAborted();
        const requestId = crypto.randomUUID();
        const body = new Uint8Array(await request.arrayBuffer());
        request.signal.throwIfAborted();
        const response = new Promise<Response>((resolve, reject) => {
            const abort = (): void => {
                this.#pending.delete(requestId);
                reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#pending.set(requestId, {
                reject: (cause) => {
                    request.signal.removeEventListener("abort", abort);
                    reject(cause);
                },
                resolve: (value) => {
                    request.signal.removeEventListener("abort", abort);
                    resolve(value);
                },
            });
        });
        try {
            socket.send(
                JSON.stringify({
                    body: bytesToBase64(body),
                    headers: Array.from(request.headers.entries()),
                    kind: WS_REQUEST_KIND,
                    method: request.method,
                    path: `${requestUrl.pathname}${requestUrl.search}`,
                    requestId,
                }),
            );
            this.#touch(socket);
        } catch (cause) {
            const pending = this.#pending.get(requestId);
            this.#pending.delete(requestId);
            pending?.reject(cause);
        }
        return await response;
    };

    readonly openLiveSessionEvents = async (request: Request): Promise<ReadableStream<MobiusTransportSessionEvent>> => {
        request.signal.throwIfAborted();
        const requestUrl = new URL(request.url);
        if (this.#origin !== null && this.#origin !== requestUrl.origin) {
            throw new MobiusValidationError("A WebSocket transport cannot connect to multiple Mobius origins");
        }
        this.#origin = requestUrl.origin;
        const socket = await this.#socket(requestUrl);
        const id = crypto.randomUUID();
        const abort = (): void => {
            const subscription = this.#subscriptions.get(id);
            this.#subscriptions.delete(id);
            subscription?.cleanup();
            if (subscription?.kind === "opening") {
                subscription.reject(request.signal.reason);
            } else {
                subscription?.controller.error(request.signal.reason);
            }
            this.#sendUnsubscribe(id);
        };
        const cleanup = (): void => request.signal.removeEventListener("abort", abort);
        const events = new Promise<ReadableStream<MobiusTransportSessionEvent>>((resolve, reject) => {
            this.#subscriptions.set(id, { cleanup, kind: "opening", reject, resolve });
        });
        request.signal.addEventListener("abort", abort, { once: true });
        try {
            socket.send(
                JSON.stringify({
                    headers: Array.from(request.headers.entries()),
                    kind: EVENT_SUBSCRIBE_KIND,
                    path: `${requestUrl.pathname}${requestUrl.search}`,
                    subscriptionId: id,
                }),
            );
            this.#touch(socket);
        } catch (cause) {
            this.#subscriptions.delete(id);
            cleanup();
            throw cause;
        }
        return await events;
    };

    readonly close = (): void => {
        const state = this.#state;
        this.#state = { kind: "closed" };
        if (state.kind === "connected") {
            globalThis.clearTimeout(state.idleTimeoutId);
            state.socket.close(1000, "Mobius transport closed");
        }
        this.#failPending(new MobiusConnectionError("The Mobius WebSocket transport closed"));
        this.#failSubscriptions(new MobiusConnectionError("The live Session event transport closed"));
    };

    readonly #socket = async (requestUrl: URL): Promise<WebSocket> => {
        switch (this.#state.kind) {
            case "closed":
                throw new MobiusConnectionError("The Mobius WebSocket transport is closed");
            case "connected":
                return this.#state.socket;
            case "connecting":
                return await this.#state.connection;
            case "disconnected": {
                const connection = this.#connect(requestUrl);
                this.#state = { kind: "connecting", connection };
                return await connection;
            }
        }
    };

    readonly #connect = async (requestUrl: URL): Promise<WebSocket> => {
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
            () => controller.abort(new MobiusConnectionError("The Mobius WebSocket connection timed out")),
            this.#connectionTimeoutMilliseconds,
        );
        const endpoint = new URL(`${MOBIUS_API_PREFIX}/v1/transport`, requestUrl.origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        try {
            const socket = await this.#connector.connect(endpoint, controller.signal);
            if (this.#state.kind === "closed") {
                socket.close(1000, "Mobius transport closed");
                throw new MobiusConnectionError("The Mobius WebSocket transport is closed");
            }
            socket.addEventListener("message", this.#receive);
            socket.addEventListener(
                "close",
                (event) => this.#disconnected(socket, webSocketCloseError(event, "remain connected")),
                {
                    once: true,
                },
            );
            socket.addEventListener(
                "error",
                () =>
                    this.#disconnected(
                        socket,
                        new MobiusConnectionError("The browser reported an error on the Mobius WebSocket"),
                    ),
                { once: true },
            );
            this.#state = this.#connected(socket);
            return socket;
        } catch (cause) {
            if (this.#state.kind !== "closed") {
                this.#state = { kind: "disconnected" };
            }
            if (cause instanceof MobiusConnectionError) {
                throw cause;
            }
            throw new MobiusConnectionError("The Mobius WebSocket transport could not connect", { cause });
        } finally {
            globalThis.clearTimeout(timeout);
        }
    };

    readonly #receive = (event: MessageEvent): void => {
        try {
            if (this.#state.kind === "connected") {
                this.#touch(this.#state.socket);
            }
            if (typeof event.data !== "string") {
                throw new MobiusProtocolError("The WebSocket transport returned a binary message");
            }
            const value: unknown = JSON.parse(event.data);
            const message = wsRecord(value);
            const kind = wsString(message, "kind", 32);
            if (kind.startsWith("session.events.")) {
                this.#receiveSubscription(kind, message);
                return;
            }
            const requestId = wsString(message, "requestId", 128);
            const pending = this.#pending.get(requestId);
            if (pending === undefined) {
                return;
            }
            this.#pending.delete(requestId);
            if (kind === WS_ERROR_KIND) {
                const status = message["status"];
                if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 400 || status > 599) {
                    throw new MobiusProtocolError("The WebSocket transport returned an invalid error status");
                }
                pending.reject(
                    new MobiusApiError(wsString(message, "code", 128), wsString(message, "message", 1_024), status),
                );
                return;
            }
            if (kind !== WS_RESPONSE_KIND) {
                throw new MobiusProtocolError("The WebSocket transport returned an unsupported message");
            }
            const status = message["status"];
            if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 200 || status > 599) {
                throw new MobiusProtocolError("The WebSocket transport returned an invalid response status");
            }
            const encodedBody = wsString(message, "body", 16_777_216);
            pending.resolve(
                new Response(base64ToBytes(encodedBody), {
                    headers: wsHeaders(message["headers"]),
                    status,
                }),
            );
        } catch (cause) {
            this.#failPending(cause);
            this.#failSubscriptions(cause);
        }
    };

    readonly #disconnected = (socket: WebSocket, cause: MobiusConnectionError): void => {
        if (this.#state.kind !== "connected" || this.#state.socket !== socket) {
            return;
        }
        globalThis.clearTimeout(this.#state.idleTimeoutId);
        this.#state = { kind: "disconnected" };
        this.#failPending(cause);
        this.#failSubscriptions(cause);
    };

    readonly #failPending = (cause: unknown): void => {
        const pending = Array.from(this.#pending.values());
        this.#pending.clear();
        for (const request of pending) {
            request.reject(cause);
        }
    };

    readonly #failSubscriptions = (cause: unknown): void => {
        const subscriptions = Array.from(this.#subscriptions.values());
        this.#subscriptions.clear();
        for (const subscription of subscriptions) {
            subscription.cleanup();
            if (subscription.kind === "opening") {
                subscription.reject(cause);
            } else {
                subscription.controller.error(cause);
            }
        }
    };

    readonly #receiveSubscription = (kind: string, message: Readonly<Record<string, unknown>>): void => {
        const id = wsString(message, "subscriptionId", 128);
        const subscription = this.#subscriptions.get(id);
        if (subscription === undefined) {
            return;
        }
        if (kind === "session.events.ready") {
            if (subscription.kind !== "opening") {
                throw new MobiusProtocolError("The live Session event subscription became ready more than once");
            }
            let streamController: ReadableStreamDefaultController<MobiusTransportSessionEvent> | null = null;
            const stream = new ReadableStream<MobiusTransportSessionEvent>({
                start(controller) {
                    streamController = controller;
                },
                cancel: () => {
                    subscription.cleanup();
                    this.#subscriptions.delete(id);
                    this.#sendUnsubscribe(id);
                },
            });
            if (streamController === null) {
                throw new MobiusProtocolError("The live Session event subscription could not initialize");
            }
            this.#subscriptions.set(id, { cleanup: subscription.cleanup, controller: streamController, kind: "open" });
            subscription.resolve(stream);
            return;
        }
        if (kind === "session.events.heartbeat") {
            return;
        }
        if (kind === "session.events.error") {
            const status = message["status"];
            if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 400 || status > 599) {
                throw new MobiusProtocolError("The live Session event subscription returned an invalid status");
            }
            const cause = new MobiusApiError(
                wsString(message, "code", 128),
                wsString(message, "message", 1_024),
                status,
            );
            this.#subscriptions.delete(id);
            subscription.cleanup();
            if (subscription.kind === "opening") {
                subscription.reject(cause);
            } else {
                subscription.controller.error(cause);
            }
            return;
        }
        if (subscription.kind !== "open") {
            throw new MobiusProtocolError("The live Session event subscription received data before it was ready");
        }
        if (kind === "session.events.end") {
            this.#subscriptions.delete(id);
            subscription.cleanup();
            subscription.controller.close();
            return;
        }
        if (kind !== "session.events.event") {
            throw new MobiusProtocolError("The live Session event subscription returned an unsupported message");
        }
        subscription.controller.enqueue({
            data: wsString(message, "data", 8 * 1024 * 1024),
            eventId: wsString(message, "eventId", 512),
        });
    };

    readonly #sendUnsubscribe = (id: string): void => {
        if (this.#state.kind !== "connected") {
            return;
        }
        this.#state.socket.send(JSON.stringify({ kind: EVENT_UNSUBSCRIBE_KIND, subscriptionId: id }));
        this.#touch(this.#state.socket);
    };

    readonly #connected = (socket: WebSocket): Extract<WsTransportState, { readonly kind: "connected" }> => ({
        kind: "connected",
        idleTimeoutId: globalThis.setTimeout(() => {
            if (this.#state.kind === "connected" && this.#state.socket === socket) {
                this.#state = { kind: "disconnected" };
                socket.close(4000, "Mobius transport idle timeout");
                this.#failPending(new MobiusConnectionError("The Mobius WebSocket transport became inactive"));
            }
        }, this.#idleTimeoutMilliseconds),
        socket,
    });

    readonly #touch = (socket: WebSocket): void => {
        if (this.#state.kind !== "connected" || this.#state.socket !== socket) {
            return;
        }
        globalThis.clearTimeout(this.#state.idleTimeoutId);
        this.#state = this.#connected(socket);
    };
}
