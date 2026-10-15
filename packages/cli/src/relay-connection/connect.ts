import { WebSocket } from "undici";

import { environmentProxyDispatcher } from "../util/network/environment-proxy.ts";
import { runtimeAuthorization } from "./runtime-authentication.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./runtime-revocation.ts";

// The Relay accepts a daemon only after it has made the Channel's previous connection offline, and a
// Project whose Runtime had several Sessions in flight takes longer to reach that point than a small one.
// A tight deadline made the daemon give up mid-accept, reconnect, and give up again, so allow enough room
// for a large Project while still failing a genuinely dead Relay.
const CONNECTION_TIMEOUT_MILLISECONDS = 60_000;

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

export function connectRelay(url: URL, signal: AbortSignal): Promise<WebSocket> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const endpoint = new URL(url);
        const headers = runtimeAuthorization(endpoint);
        endpoint.searchParams.delete("token");
        const socket = new WebSocket(endpoint, {
            dispatcher: environmentProxyDispatcher,
            headers,
        });
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
            resolve(socket);
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
