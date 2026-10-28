import { DurableObject } from "cloudflare:workers";
import type { WebSocketHost } from "@moxt-ai/mobius-relay-core";
import { type ConfiguredPlatformRelayBindings, createPlatformSocketWorker } from "../platform-worker.ts";

type SocketHandlers = Parameters<WebSocketHost["accept"]>[1];

export class WebSocketTransport extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #handlers = new Map<WebSocket, SocketHandlers>();
    readonly #application = createPlatformSocketWorker({
        accept: (socket, handlers) => {
            this.#handlers.set(socket, handlers);
            this.ctx.acceptWebSocket(socket);
        },
        lastHeartbeatAt: (socket) => this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
    });

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"kind":"ping"}', '{"kind":"pong"}'));
        // Active transport deadlines keep connection-owned uploads and upstream subscriptions
        // resident. A restart must reconnect instead of silently dropping that transient state.
        for (const socket of state.getWebSockets()) {
            socket.close(1012, "WebSocket transport restarted");
        }
    }

    override async fetch(request: Request): Promise<Response> {
        return await this.#application.fetch(request, this.env);
    }

    override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
        this.#handlers.get(socket)?.message(message);
    }

    override webSocketClose(socket: WebSocket): void {
        this.#handlers.get(socket)?.close();
        this.#handlers.delete(socket);
    }

    override webSocketError(socket: WebSocket): void {
        this.#handlers.get(socket)?.error();
        this.#handlers.delete(socket);
        socket.close(1011, "WebSocket transport failed");
    }
}
