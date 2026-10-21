import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionInfoUpdatedEvent,
    type SessionLiveEvent,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import type { ScheduledTask, Timer } from "./timer.ts";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const SESSION_EVENT_BATCH_WINDOW_MILLISECONDS = 100;

/** Live delivery is best-effort. Recovery snapshots are owned by the daemon's local Session cache. */
export class RuntimeSessionEventPublisher {
    #pendingEvents: SessionLiveEvent[] = [];
    #pendingTask: ScheduledTask | null = null;
    #socket: WebSocket | null = null;
    readonly #timer: Timer;

    constructor(timer: Timer) {
        this.#timer = timer;
    }

    readonly connect = (socket: WebSocket): void => {
        this.dropPendingEvents();
        this.#socket = socket;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
            this.dropPendingEvents();
        }
    };

    readonly close = (): void => {
        this.#socket = null;
        this.dropPendingEvents();
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

    readonly publish = (event: SessionLiveEvent): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        this.#pendingEvents.push(event);
        if (this.#pendingEvents.length >= SESSION_EVENT_BATCH_MAX_SIZE) {
            this.flushEvents(socket);
            return;
        }
        this.#pendingTask ??= this.#timer.schedule(
            () => this.flushEvents(socket),
            SESSION_EVENT_BATCH_WINDOW_MILLISECONDS,
        );
    };

    private readonly dropPendingEvents = (): void => {
        this.#pendingTask?.cancel();
        this.#pendingTask = null;
        this.#pendingEvents = [];
    };

    private readonly flushEvents = (socket: WebSocket): void => {
        this.#pendingTask?.cancel();
        this.#pendingTask = null;
        const events = this.#pendingEvents;
        this.#pendingEvents = [];
        if (events.length === 0 || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage({ events, kind: SESSION_EVENT_KIND });
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
