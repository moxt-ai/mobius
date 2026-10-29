export interface WebSocketHost {
    readonly accept: (
        socket: WebSocket,
        handlers: {
            readonly message: (data: string | ArrayBuffer) => void;
            readonly close: () => void;
            readonly error: () => void;
        },
    ) => void;
    readonly lastHeartbeatAt: (socket: WebSocket) => number | null;
}

/** Standard acceptance remains available to non-Durable-Object hosts. */
export const standardWebSocketHost: WebSocketHost = {
    accept: (socket, handlers) => {
        socket.accept();
        socket.addEventListener("message", (event) => handlers.message(event.data));
        socket.addEventListener("close", handlers.close, { once: true });
        socket.addEventListener("error", handlers.error, { once: true });
    },
    lastHeartbeatAt: () => null,
};
