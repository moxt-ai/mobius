import {
    encodeDaemonToServiceMessage,
    encodeRecordedSessionEvent,
    type RecordedSessionEvent,
    SESSION_EVENT_KIND,
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

    readonly publish = (sessionId: string, event: RecordedSessionEvent): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage({
            kind: SESSION_EVENT_KIND,
            payload: encodeRecordedSessionEvent(event),
            sessionId,
        });
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(1013, "Live event transport overloaded");
            return;
        }
        try {
            socket.send(encoded);
        } catch {
            // Socket liveness owns reconnection. Missed events are not delivery work.
        }
    };

    readonly publishBatch = (sessionId: string, events: readonly RecordedSessionEvent[]): void => {
        for (const event of events) {
            this.publish(sessionId, event);
        }
    };

    readonly publishStatus = (event: SessionStatusChangedEvent): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage(event);
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(1013, "Live event transport overloaded");
            return;
        }
        try {
            socket.send(encoded);
        } catch {
            // Socket liveness owns reconnection. The Session directory provides recovery snapshots.
        }
    };

    readonly publishV2 = (event: SessionEventV2): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage({ event, kind: SESSION_EVENT_V2_KIND });
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(1013, "Live event transport overloaded");
            return;
        }
        try {
            socket.send(encoded);
        } catch {
            // Socket liveness owns reconnection. Missed events are recovered from the local cache.
        }
    };
}
