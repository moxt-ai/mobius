import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    SESSION_EVENT_V2_BATCH_MAX_SIZE,
    SESSION_EVENT_V2_KIND,
    type SessionInfoUpdatedEvent,
    type SessionLiveEventV2,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS = 100;

/** Live delivery is best-effort. Recovery snapshots are owned by the daemon's local Session cache. */
export class DaemonSessionEventPublisher {
    #pendingV2Events: SessionLiveEventV2[] = [];
    #pendingV2Task: DaemonScheduledTask | null = null;
    #socket: WebSocket | null = null;
    readonly #timer: DaemonTimer;

    constructor(timer: DaemonTimer) {
        this.#timer = timer;
    }

    readonly connect = (socket: WebSocket): void => {
        this.dropPendingV2Events();
        this.#socket = socket;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
            this.dropPendingV2Events();
        }
    };

    readonly close = (): void => {
        this.#socket = null;
        this.dropPendingV2Events();
    };

    readonly publishOperationFailure = (sessionId: string, requestId: string, code: string, message: string): void => {
        this.#send({ kind: "session.operation.failed", sessionId, requestId, code, message });
    };
    readonly publishStatus = (event: SessionStatusChangedEvent): void => this.#send(event);
    readonly publishInfo = (event: SessionInfoUpdatedEvent): void => this.#send(event);

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

    readonly publishV2 = (event: SessionLiveEventV2): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        this.#pendingV2Events.push(event);
        if (this.#pendingV2Events.length >= SESSION_EVENT_V2_BATCH_MAX_SIZE) {
            this.flushV2Events(socket);
            return;
        }
        this.#pendingV2Task ??= this.#timer.schedule(
            () => this.flushV2Events(socket),
            SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS,
        );
    };

    private readonly dropPendingV2Events = (): void => {
        this.#pendingV2Task?.cancel();
        this.#pendingV2Task = null;
        this.#pendingV2Events = [];
    };

    private readonly flushV2Events = (socket: WebSocket): void => {
        this.#pendingV2Task?.cancel();
        this.#pendingV2Task = null;
        const events = this.#pendingV2Events;
        this.#pendingV2Events = [];
        if (events.length === 0 || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage({ events, kind: SESSION_EVENT_V2_KIND });
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
