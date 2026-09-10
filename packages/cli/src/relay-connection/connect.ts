import { WebSocket } from "undici";

import { environmentProxyDispatcher } from "../network/environment-proxy.ts";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;

class RelayConnectionError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RelayConnectionError";
    }
}

export function connectRelay(url: URL, signal: AbortSignal): Promise<WebSocket> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const endpoint = new URL(url);
        const headers: Record<string, string> = {};
        if (endpoint.pathname.endsWith("/v1/runtimes/connect")) {
            const runtimeCredential = endpoint.searchParams.get("token") ?? "";
            endpoint.searchParams.delete("token");
            headers["authorization"] = `Bearer ${runtimeCredential}`;
        }
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
        const fail = (error: RelayConnectionError): void => {
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
                new RelayConnectionError("relay_connection_cancelled", "Relay connection was cancelled", {
                    cause: signal.reason,
                }),
            );
        };
        const onClose = (): void => {
            fail(new RelayConnectionError("relay_connection_closed", "Relay connection closed before it was ready"));
        };
        const onError = (): void => {
            fail(new RelayConnectionError("relay_connection_failed", "Relay connection failed"));
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
            fail(new RelayConnectionError("relay_connection_timeout", "Relay connection timed out"));
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
