import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import { type HttpError, toHttpError } from "../../entity/http-error.ts";
import { diagnosticText, serializeDiagnosticError } from "../../infra/log-diagnostics.ts";
import { logger } from "../../infra/logger.ts";

const REQUEST_KIND = "http.request";
const RESPONSE_KIND = "http.response";
const ERROR_KIND = "http.error";
const EVENT_SUBSCRIBE_KIND = "session.events.subscribe";
const EVENT_UNSUBSCRIBE_KIND = "session.events.unsubscribe";
const MAX_BODY_BYTES = 12_582_912;
const IDLE_TIMEOUT_MILLISECONDS = 60_000;
const LIVE_EVENT_HEARTBEAT_MILLISECONDS = 20_000;
const MAX_SUBSCRIPTION_DIAGNOSTICS = 8;
const FORBIDDEN_HEADERS = new Set([
    "connection",
    "content-length",
    "forwarded",
    "host",
    "origin",
    "upgrade",
    "x-mobius-project-id",
]);

type DispatchRequest = (request: Request) => Promise<Response>;
type SubscriptionEnd =
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "close"; readonly code: number; readonly reason: string; readonly wasClean: boolean };
type WebSocketTransportErrorCode =
    | "invalid_headers"
    | "invalid_message"
    | "invalid_method"
    | "invalid_target"
    | "request_too_large"
    | "response_too_large"
    | "streaming_response_unsupported";

const TRANSPORT_ERRORS: Readonly<
    Record<WebSocketTransportErrorCode, { readonly message: string; readonly status: number }>
> = {
    invalid_headers: { message: "The WebSocket transport headers are invalid", status: 400 },
    invalid_message: { message: "The WebSocket transport message is invalid", status: 400 },
    invalid_method: { message: "The WebSocket transport method is invalid", status: 400 },
    invalid_target: { message: "The WebSocket transport target is invalid", status: 400 },
    request_too_large: { message: "The WebSocket transport request is too large", status: 413 },
    response_too_large: { message: "The WebSocket transport response is too large", status: 502 },
    streaming_response_unsupported: {
        message: "The WebSocket transport does not support streaming responses",
        status: 501,
    },
};

class WebSocketTransportError extends Error implements HttpError {
    readonly #code: WebSocketTransportErrorCode;
    readonly #status: number;

    constructor(code: WebSocketTransportErrorCode) {
        const error = TRANSPORT_ERRORS[code];
        super(error.message);
        this.name = "WebSocketTransportError";
        this.#code = code;
        this.#status = error.status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.#code, message: this.message } },
        status: this.#status,
    });
}

function transportError(code: WebSocketTransportErrorCode): WebSocketTransportError {
    return new WebSocketTransportError(code);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw transportError("invalid_message");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string, maximum: number): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw transportError("invalid_message");
    }
    return candidate;
}

function requestBody(value: Readonly<Record<string, unknown>>): string {
    const body = string(value, "body", MAX_BODY_BYTES);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        throw transportError("request_too_large");
    }
    return body;
}

function headers(value: unknown): Headers {
    if (!Array.isArray(value) || value.length > 128) {
        throw transportError("invalid_headers");
    }
    const decoded = new Headers();
    for (const entry of value) {
        if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            typeof entry[1] !== "string" ||
            entry[0].length > 256 ||
            entry[1].length > 16_384
        ) {
            throw transportError("invalid_headers");
        }
        const name = entry[0].toLowerCase();
        if (
            FORBIDDEN_HEADERS.has(name) ||
            name.startsWith("cf-") ||
            name.startsWith("sec-websocket-") ||
            name.startsWith("x-forwarded-")
        ) {
            throw transportError("invalid_headers");
        }
        decoded.append(entry[0], entry[1]);
    }
    return decoded;
}

function requestIdFromMessage(value: Readonly<Record<string, unknown>>): string {
    if (string(value, "kind", 32) !== REQUEST_KIND) {
        throw transportError("invalid_message");
    }
    const requestId = string(value, "requestId", 128);
    if (!/^[a-zA-Z0-9-]{1,128}$/u.test(requestId)) {
        throw transportError("invalid_message");
    }
    return requestId;
}

function requestFromMessage(
    value: Readonly<Record<string, unknown>>,
    requestId: string,
    origin: string,
    browserOrigin: string | null,
    signal: AbortSignal,
): { readonly request: Request; readonly requestId: string } {
    const path = string(value, "path", 8_192);
    if (!path.startsWith(`${MOBIUS_API_PREFIX}/`) || path.startsWith(`${MOBIUS_API_PREFIX}/v1/transport`)) {
        throw transportError("invalid_target");
    }
    const endpoint = new URL(path, origin);
    if (endpoint.origin !== origin || `${endpoint.pathname}${endpoint.search}` !== path || endpoint.hash.length > 0) {
        throw transportError("invalid_target");
    }
    const method = string(value, "method", 16);
    if (!["DELETE", "GET", "PATCH", "POST", "PUT"].includes(method)) {
        throw transportError("invalid_method");
    }
    const body = requestBody(value);
    if (method === "GET" && body.length > 0) {
        throw transportError("invalid_message");
    }
    const requestHeaders = headers(value["headers"]);
    if (browserOrigin !== null) {
        requestHeaders.set("origin", browserOrigin);
    }
    return {
        request: new Request(endpoint, {
            body: body.length === 0 || method === "GET" ? null : body,
            headers: requestHeaders,
            method,
            signal,
        }),
        requestId,
    };
}

function responseHeaders(response: Response): readonly (readonly [string, string])[] {
    return Array.from(response.headers.entries()).filter(
        ([name]) => !FORBIDDEN_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith("sec-websocket-"),
    );
}

export function acceptWebSocketHttpTransport(request: Request, dispatch: DispatchRequest): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json(
            { error: { code: "websocket_upgrade_required", message: "A WebSocket upgrade is required" } },
            { status: 426 },
        );
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const controller = new AbortController();
    const subscriptions = new Map<
        string,
        | { readonly kind: "pending"; readonly controller: AbortController }
        | { readonly kind: "open"; readonly socket: WebSocket }
    >();
    const browserOrigin = request.headers.get("origin");
    let subscriptionDiagnosticCount = 0;
    let idleTimeout = setTimeout(() => {
        controller.abort(new Error("WebSocket transport became inactive"));
        server.close(1001, "WebSocket transport idle timeout");
    }, IDLE_TIMEOUT_MILLISECONDS);
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    const touch = (): void => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
            controller.abort(new Error("WebSocket transport became inactive"));
            server.close(1001, "WebSocket transport idle timeout");
        }, IDLE_TIMEOUT_MILLISECONDS);
    };
    const scheduleHeartbeat = (): void => {
        if (heartbeatTimeout !== null) {
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
        }
        if (subscriptions.size === 0 || server.readyState !== WebSocket.OPEN) {
            return;
        }
        heartbeatTimeout = setTimeout(() => {
            heartbeatTimeout = null;
            if (server.readyState !== WebSocket.OPEN) {
                return;
            }
            for (const subscriptionId of subscriptions.keys()) {
                server.send(JSON.stringify({ kind: "session.events.heartbeat", subscriptionId }));
            }
            touch();
            scheduleHeartbeat();
        }, LIVE_EVENT_HEARTBEAT_MILLISECONDS);
    };
    server.accept();
    server.addEventListener(
        "close",
        () => {
            clearTimeout(idleTimeout);
            if (heartbeatTimeout !== null) {
                clearTimeout(heartbeatTimeout);
                heartbeatTimeout = null;
            }
            for (const subscription of subscriptions.values()) {
                if (subscription.kind === "pending") {
                    subscription.controller.abort(new Error("WebSocket transport closed"));
                } else if (
                    subscription.socket.readyState === WebSocket.OPEN ||
                    subscription.socket.readyState === WebSocket.CONNECTING
                ) {
                    subscription.socket.close(1000, "WebSocket transport closed");
                }
            }
            subscriptions.clear();
        },
        { once: true },
    );
    server.addEventListener(
        "error",
        () => {
            clearTimeout(idleTimeout);
            if (heartbeatTimeout !== null) {
                clearTimeout(heartbeatTimeout);
                heartbeatTimeout = null;
            }
        },
        { once: true },
    );
    server.addEventListener("message", (event) => {
        touch();
        void (async () => {
            let requestId = "unknown";
            try {
                if (typeof event.data !== "string") {
                    throw transportError("invalid_message");
                }
                const decoded: unknown = JSON.parse(event.data);
                const message = record(decoded);
                const kind = string(message, "kind", 32);
                if (kind === EVENT_UNSUBSCRIBE_KIND) {
                    const subscriptionId = string(message, "subscriptionId", 128);
                    const subscription = subscriptions.get(subscriptionId);
                    if (subscription?.kind === "pending") {
                        subscription.controller.abort(new Error("Session event subscription closed"));
                    } else if (
                        subscription?.kind === "open" &&
                        (subscription.socket.readyState === WebSocket.OPEN ||
                            subscription.socket.readyState === WebSocket.CONNECTING)
                    ) {
                        subscription.socket.close(1000, "Session event subscription closed");
                    }
                    subscriptions.delete(subscriptionId);
                    scheduleHeartbeat();
                    return;
                }
                if (kind === EVENT_SUBSCRIBE_KIND) {
                    const subscriptionId = string(message, "subscriptionId", 128);
                    if (!/^[a-zA-Z0-9-]{1,128}$/u.test(subscriptionId) || subscriptions.has(subscriptionId)) {
                        throw transportError("invalid_message");
                    }
                    requestId = subscriptionId;
                    const subscriptionController = new AbortController();
                    const converted = requestFromMessage(
                        {
                            body: "",
                            headers: message["headers"],
                            kind: REQUEST_KIND,
                            method: "GET",
                            path: message["path"],
                            requestId: subscriptionId,
                        },
                        subscriptionId,
                        new URL(request.url).origin,
                        browserOrigin,
                        subscriptionController.signal,
                    );
                    subscriptions.set(subscriptionId, { controller: subscriptionController, kind: "pending" });
                    scheduleHeartbeat();
                    const subscriptionHeaders = new Headers(converted.request.headers);
                    subscriptionHeaders.set("Upgrade", "websocket");
                    const response = await dispatch(new Request(converted.request, { headers: subscriptionHeaders }));
                    const subscription = response.webSocket;
                    if (subscription === null) {
                        subscriptions.delete(subscriptionId);
                        scheduleHeartbeat();
                        const failure = await response.json().catch(() => null);
                        const error =
                            typeof failure === "object" && failure !== null && "error" in failure
                                ? record(Reflect.get(failure, "error"))
                                : {};
                        server.send(
                            JSON.stringify({
                                code: typeof error["code"] === "string" ? error["code"] : "session_unavailable",
                                kind: "session.events.error",
                                message:
                                    typeof error["message"] === "string"
                                        ? error["message"]
                                        : "The Session event subscription is unavailable",
                                status: response.status >= 400 ? response.status : 502,
                                subscriptionId,
                            }),
                        );
                        return;
                    }
                    if (subscriptions.get(subscriptionId)?.kind !== "pending") {
                        subscription.close(1000, "Session event subscription closed");
                        return;
                    }
                    subscriptions.set(subscriptionId, { kind: "open", socket: subscription });
                    let nextSequenceId = 1;
                    const openedAt = Date.now();
                    let lastMessageAt: number | null = null;
                    const finish = (end: SubscriptionEnd): void => {
                        const current = subscriptions.get(subscriptionId);
                        if (
                            current?.kind === "open" &&
                            current.socket === subscription &&
                            subscriptions.delete(subscriptionId) &&
                            server.readyState === WebSocket.OPEN
                        ) {
                            const unexpected =
                                end.kind === "error" || !end.wasClean || (end.code !== 1000 && end.code !== 1001);
                            // A flapping subscription must not produce an unbounded log stream.
                            // Normal unsubscribe, browser close, and clean upstream close remain quiet.
                            if (unexpected && subscriptionDiagnosticCount < MAX_SUBSCRIPTION_DIAGNOSTICS) {
                                subscriptionDiagnosticCount += 1;
                                const now = Date.now();
                                logger.warn(
                                    {
                                        event: "session_event_subscription_disconnected",
                                        source: end.kind === "error" ? "upstream_error" : "upstream_close",
                                        cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                                        path: new URL(converted.request.url).pathname,
                                        subscriptionId,
                                        elapsedMilliseconds: Math.max(0, now - openedAt),
                                        lastMessageAgeMilliseconds:
                                            lastMessageAt === null ? null : Math.max(0, now - lastMessageAt),
                                        messageCount: nextSequenceId - 1,
                                        ...(end.kind === "error"
                                            ? { error: serializeDiagnosticError(end.error) }
                                            : {
                                                  closeCode: end.code,
                                                  closeReason: diagnosticText(end.reason, 256),
                                                  wasClean: end.wasClean,
                                              }),
                                    },
                                    "Session event subscription disconnected",
                                );
                            }
                            scheduleHeartbeat();
                            server.send(JSON.stringify({ kind: "session.events.end", subscriptionId }));
                        }
                    };
                    subscription.addEventListener("message", (subscriptionEvent) => {
                        if (
                            typeof subscriptionEvent.data === "string" &&
                            server.readyState === WebSocket.OPEN &&
                            subscriptions.get(subscriptionId)?.kind === "open"
                        ) {
                            lastMessageAt = Date.now();
                            server.send(
                                JSON.stringify({
                                    data: subscriptionEvent.data,
                                    eventId: "",
                                    kind: "session.events.event",
                                    seqId: nextSequenceId,
                                    subscriptionId,
                                }),
                            );
                            nextSequenceId += 1;
                            touch();
                        }
                    });
                    subscription.addEventListener(
                        "close",
                        (event) =>
                            finish({ kind: "close", code: event.code, reason: event.reason, wasClean: event.wasClean }),
                        { once: true },
                    );
                    subscription.addEventListener(
                        "error",
                        (event) => finish({ kind: "error", error: "error" in event ? event.error : undefined }),
                        { once: true },
                    );
                    subscription.accept();
                    server.send(JSON.stringify({ kind: "session.events.ready", subscriptionId }));
                    touch();
                    return;
                }
                requestId = requestIdFromMessage(message);
                const converted = requestFromMessage(
                    message,
                    requestId,
                    new URL(request.url).origin,
                    browserOrigin,
                    controller.signal,
                );
                requestId = converted.requestId;
                const response = await dispatch(converted.request);
                const mediaType = response.headers.get("content-type") ?? "";
                if (mediaType.startsWith("text/event-stream")) {
                    throw transportError("streaming_response_unsupported");
                }
                const body = await response.text();
                if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
                    throw transportError("response_too_large");
                }
                server.send(
                    JSON.stringify({
                        body,
                        headers: responseHeaders(response),
                        kind: RESPONSE_KIND,
                        requestId,
                        status: response.status,
                    }),
                );
                touch();
            } catch (cause) {
                if (controller.signal.aborted || server.readyState !== WebSocket.OPEN) {
                    return;
                }
                logger.error({ err: cause, requestId }, "Mobius WebSocket transport request failed");
                const httpError = toHttpError(cause);
                server.send(
                    JSON.stringify({
                        code: httpError.body.error.code,
                        kind: ERROR_KIND,
                        message: httpError.body.error.message,
                        requestId,
                        status: httpError.status,
                    }),
                );
            }
        })();
    });
    return new Response(null, { status: 101, webSocket: client });
}
