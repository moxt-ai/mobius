import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    SESSION_EVENT_V2_KIND,
    type SessionEventV2,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** Live delivery is best-effort. Recovery snapshots are owned by the daemon's local Session cache. */
export class DaemonSessionEventPublisher {
    #socket: WebSocket | null = null;

    readonly connect = (socket: WebSocket): void => {
        this.#socket = socket;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
        }
    };

    readonly close = (): void => {
        this.#socket = null;
    };

    readonly publishOperationFailure = (sessionId: string, requestId: string, code: string, message: string): void => {
        this.#send({ kind: "session.operation.failed", sessionId, requestId, code, message });
    };
    readonly publishStatus = (event: SessionStatusChangedEvent): void => this.#send(event);
    readonly publishV2 = (event: SessionEventV2): void => this.#send({ event, kind: SESSION_EVENT_V2_KIND });

    readonly #send = (message: DaemonToServiceMessage): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage(message);
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(1013, "Live event transport overloaded");
            return;
        }
        try {
            socket.send(encoded);
        } catch {
            /* Connection liveness owns reconnection; live messages are not retried. */
        }
    };
}
