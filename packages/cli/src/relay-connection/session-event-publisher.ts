import {
    encodeDaemonToServiceMessage,
    encodeRecordedSessionEvent,
    type RecordedSessionEvent,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";

const MAX_LIVE_EVENT_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Live Session events are disposable: native Agent history and the active Turn snapshot restore viewers. */
export class DaemonSessionEventPublisher {
    #socket: WebSocket | null = null;
    #reportedDrop = false;

    readonly connect = (socket: WebSocket): void => {
        this.#socket = socket;
        this.#reportedDrop = false;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
        }
    };

    readonly publish = (sessionId: string, event: RecordedSessionEvent): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            this.#reportDrop();
            return;
        }
        if (socket.bufferedAmount >= MAX_LIVE_EVENT_BUFFERED_BYTES) {
            this.#socket = null;
            socket.close(1013, "Live event backpressure");
            this.#reportDrop();
            return;
        }
        try {
            socket.send(
                encodeDaemonToServiceMessage({
                    kind: SESSION_EVENT_KIND,
                    payload: encodeRecordedSessionEvent(event),
                    sessionId,
                }),
            );
        } catch {
            this.#reportDrop();
        }
    };

    readonly close = (): void => {
        this.#socket = null;
    };

    readonly #reportDrop = (): void => {
        if (this.#reportedDrop) {
            return;
        }
        this.#reportedDrop = true;
        console.warn("Mobius daemon dropped live Session events while the Relay was unavailable");
    };
}
