import type { DurableObjectContext } from "../di/create-durable-object-dependencies.ts";
import { CloudflareChannelSocket } from "../gateway/cloudflare-channel-peers.ts";

export class RuntimeRelay {
    readonly #dependencies: DurableObjectContext;

    constructor(dependencies: DurableObjectContext) {
        this.#dependencies = dependencies;
    }

    async fetch(request: Request): Promise<Response> {
        return await this.withOperationSignal(
            async (signal) => await this.#dependencies.applications.runtime.fetch(new Request(request, { signal })),
            request.signal,
        );
    }

    async alarm(): Promise<void> {
        await this.withOperationSignal((signal) => this.#dependencies.services.runtime.alarm(signal));
    }

    async openLiveSessionEventSocket(
        subscriptionId: string,
        projectId: string,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<Response> {
        return await this.#dependencies.services.runtime.acceptHost(
            {
                channelId: subscriptionId,
                credentialId: `live_${subscriptionId}`,
                projectId,
                role: "host",
                runtimeId,
            },
            signal,
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
        } finally {
            webSocket.removeEventListener("close", close);
        }
    }

    async webSocketClose(webSocket: WebSocket): Promise<void> {
        const socket = new CloudflareChannelSocket(webSocket);
        await this.withOperationSignal((signal) =>
            this.#dependencies.services.runtime.detach(socket.identity(), socket, signal),
        );
    }

    webSocketError(socket: WebSocket): void {
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
