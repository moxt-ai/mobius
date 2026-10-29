import { type Dispatcher, WebSocket } from "undici";

import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import { relayAuthorization } from "./relay-authentication.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./runtime-revocation.ts";

// The Relay accepts a daemon only after it has made the Channel's previous connection offline, and a
// Project whose Runtime had several Sessions in flight takes longer to reach that point than a small one.
// A tight deadline made the daemon give up mid-accept, reconnect, and give up again, so allow enough room
// for a large Project while still failing a genuinely dead Relay.
const CONNECTION_TIMEOUT_MILLISECONDS = 60_000;

export interface RelayConnection {
    readonly socket: WebSocket;
    /** Releases the underlying transport after the WebSocket close frame has been queued. */
    readonly release: (reason: Error) => void;
}

class RelayConnectionError extends Error {
    readonly code: string;
    readonly diagnosticDetails: Readonly<Record<string, string>>;

    constructor(
        code: string,
        message: string,
        diagnosticDetails: Readonly<Record<string, string>> = {},
        options: ErrorOptions = {},
    ) {
        super(message, options);
        this.code = code;
        this.diagnosticDetails = diagnosticDetails;
        this.name = "RelayConnectionError";
    }
}

export function connectRelay(url: URL, signal: AbortSignal): Promise<RelayConnection> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        let releaseTransport: (reason: Error) => void = () => undefined;
        const dispatcher = environmentProxyDispatcher.compose((dispatch) => (options, handler) => {
            const trackedHandler = Object.create(handler) as Dispatcher.DispatchHandler;
            trackedHandler.onRequestStart = (controller, context): void => {
                releaseTransport = (reason) => controller.abort(reason);
                handler.onRequestStart?.(controller, context);
            };
            trackedHandler.onRequestUpgrade = (controller, statusCode, responseHeaders, transport) => {
                // An upgraded connection no longer belongs to the HTTP request controller.
                // Its owner must release the socket even when the peer never acknowledges close.
                releaseTransport = (reason) => transport.destroy(reason);
                return handler.onRequestUpgrade?.(controller, statusCode, responseHeaders, transport);
            };
            return dispatch(options, trackedHandler);
        });
        const endpoint = new URL(url);
        const headers = relayAuthorization(endpoint);
        endpoint.searchParams.delete("token");
        const socket = new WebSocket(endpoint, {
            dispatcher,
            headers,
        });
        socket.binaryType = "arraybuffer";
        let released = false;
        const release = (reason: Error): void => {
            if (released) {
                return;
            }
            released = true;
            releaseTransport(reason);
        };
        let finished = false;
        const timeout = setTimeout(onTimeout, CONNECTION_TIMEOUT_MILLISECONDS);

        const cleanup = (): void => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("open", onOpen);
        };
        const fail = (error: Error): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            socket.close();
            release(error);
            reject(error);
        };
        const onAbort = (): void => {
            fail(
                new RelayConnectionError(
                    "relay_connection_cancelled",
                    "Relay connection was cancelled",
                    {
                        cancellation: "requested",
                    },
                    { cause: signal.reason },
                ),
            );
        };
        const onClose = (event: CloseEvent): void => {
            if (isRuntimeRelayRevocation(event.code, event.reason)) {
                fail(new RuntimeRelayRevokedError(event.code, event.reason));
                return;
            }
            fail(
                new RelayConnectionError("relay_connection_closed", "Relay connection closed before it was ready", {
                    closeCode: event.code.toString(),
                    closeReason: event.reason,
                }),
            );
        };
        const onError = (event: Event): void => {
            const cause = Reflect.get(event, "error");
            fail(
                new RelayConnectionError(
                    "relay_connection_failed",
                    "Relay connection failed",
                    {},
                    { cause: cause ?? event },
                ),
            );
        };
        const onOpen = (): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve({ release, socket });
        };
        function onTimeout(): void {
            fail(
                new RelayConnectionError("relay_connection_timeout", "Relay connection timed out", {
                    timeoutMilliseconds: CONNECTION_TIMEOUT_MILLISECONDS.toString(),
                }),
            );
        }

        signal.addEventListener("abort", onAbort, { once: true });
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("open", onOpen, { once: true });

        if (signal.aborted) {
            onAbort();
        }
    });
}
