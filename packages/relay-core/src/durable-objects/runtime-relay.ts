import type { DurableObjectContext } from "../di/create-durable-object-dependencies.ts";
import { CloudflareChannelSocket } from "../gateway/cloudflare-channel-peers.ts";
import { diagnosticText } from "../infra/log-diagnostics.ts";
import { logger } from "../infra/logger.ts";

function socketLogContext(webSocket: WebSocket) {
    try {
        const identity = new CloudflareChannelSocket(webSocket).identity();
        const { projectId, runtimeId, role } = identity;
        return {
            projectId,
            runtimeId,
            role,
            ...("connectionEpoch" in identity
                ? { connectionEpoch: identity.connectionEpoch, connectionId: identity.connectionId }
                : { channelId: identity.channelId }),
        };
    } catch {
        // A socket can fail before it has a valid attachment.
        return { role: "unknown" };
    }
}

export class RuntimeRelay {
    readonly #dependencies: DurableObjectContext;
    readonly #logger: typeof logger;

    constructor(dependencies: DurableObjectContext, diagnostics = logger) {
        this.#dependencies = dependencies;
        this.#logger = diagnostics;
    }

    async fetch(request: Request): Promise<Response> {
        return await this.withOperationSignal(
            async (signal) => await this.#dependencies.applications.runtime.fetch(new Request(request, { signal })),
            request.signal,
        );
    }

    async webSocketMessage(webSocket: WebSocket, message: unknown): Promise<void> {
        const socket = new CloudflareChannelSocket(webSocket);
        const controller = new AbortController();
        const close = () => controller.abort(new DOMException("The channel socket closed", "AbortError"));
        webSocket.addEventListener("close", close, { once: true });
        try {
            await this.#dependencies.services.runtime.receiveMessage(
                socket.identity(),
                socket,
                message,
                controller.signal,
            );
        } catch (error) {
            if (!controller.signal.aborted || error !== controller.signal.reason) {
                this.#logger.error(
                    { ...socketLogContext(webSocket), err: error, event: "runtime_websocket_message_failed" },
                    "Runtime WebSocket message failed",
                );
            }
            throw error;
        } finally {
            webSocket.removeEventListener("close", close);
        }
    }

    async webSocketClose(
        webSocket: WebSocket,
        close: { readonly code: number; readonly reason: string; readonly wasClean: boolean },
    ): Promise<void> {
        const context = socketLogContext(webSocket);
        const details = {
            ...context,
            closeCode: close.code,
            closeReason: diagnosticText(close.reason),
            wasClean: close.wasClean,
            event: "runtime_websocket_closed",
        };
        if (!close.wasClean || (close.code !== 1000 && close.code !== 1001)) {
            this.#logger.warn(details, "Runtime WebSocket closed");
        } else if (context.role === "daemon" || context.role === "replaced-daemon") {
            this.#logger.info(details, "Runtime WebSocket closed");
        }
        const socket = new CloudflareChannelSocket(webSocket);
        try {
            await this.withOperationSignal((signal) =>
                this.#dependencies.services.runtime.detach(socket.identity(), socket, signal),
            );
        } catch (error) {
            this.#logger.error(
                { ...details, err: error, event: "runtime_websocket_detach_failed" },
                "Runtime WebSocket detach failed",
            );
            throw error;
        }
    }

    webSocketError(socket: WebSocket, error: unknown): void {
        this.#logger.error(
            { ...socketLogContext(socket), err: error, event: "runtime_websocket_error" },
            "Runtime WebSocket error",
        );
        socket.close(1011, "WebSocket error");
    }

    private readonly withOperationSignal = async <T>(
        operation: (signal: AbortSignal) => Promise<T>,
        parentSignal?: AbortSignal,
    ): Promise<T> => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Runtime operation timed out", "TimeoutError")),
            30_000,
        );
        try {
            return await operation(
                parentSignal === undefined ? controller.signal : AbortSignal.any([parentSignal, controller.signal]),
            );
        } finally {
            clearTimeout(timer);
        }
    };
}
