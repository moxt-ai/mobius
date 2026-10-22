import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionCloseNoticeEvent,
    type SessionInfoUpdatedEvent,
    type SessionLiveEvent,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import type { ScheduledTask, Timer } from "./timer.ts";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BATCH_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// Browser-compatible WebSocket clients may initiate only 1000 or application close codes.
const LOCAL_BACKPRESSURE_CLOSE_CODE = 4009;
const EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ events: [], kind: SESSION_EVENT_KIND }));
export const SESSION_EVENT_BATCH_WINDOW_MILLISECONDS = 100;

/** Live delivery is best-effort. Recovery snapshots are owned by the daemon's local Session cache. */
export class RuntimeSessionEventPublisher {
    #pendingEvents: SessionLiveEvent[] = [];
    #pendingBytes = EMPTY_ENVELOPE_BYTES;
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
    readonly publishClosed = (event: SessionCloseNoticeEvent): void => this.#send(event);

    readonly #send = (message: DaemonToServiceMessage): void => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage(message);
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
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
        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
        if (bytes + EMPTY_ENVELOPE_BYTES > MAX_FRAME_BYTES) {
            console.warn("Live Session event exceeds the Relay frame limit", {
                code: "live_event_too_large",
                sessionId: event.sessionId,
                eventId: event.eventId,
                bytes,
            });
            return;
        }
        if (this.#pendingEvents.length > 0 && this.#pendingBytes + bytes > MAX_EVENT_BATCH_BYTES) {
            this.flushEvents(socket);
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
        }
        this.#pendingEvents.push(event);
        this.#pendingBytes += bytes;
        if (this.#pendingEvents.length >= SESSION_EVENT_BATCH_MAX_SIZE || this.#pendingBytes >= MAX_EVENT_BATCH_BYTES) {
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
        this.#pendingBytes = EMPTY_ENVELOPE_BYTES;
    };

    private readonly flushEvents = (socket: WebSocket): void => {
        this.#pendingTask?.cancel();
        this.#pendingTask = null;
        const events = this.#pendingEvents;
        this.#pendingEvents = [];
        this.#pendingBytes = EMPTY_ENVELOPE_BYTES;
        if (events.length === 0 || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const encoded = encodeDaemonToServiceMessage({ events, kind: SESSION_EVENT_KIND });
        if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
            socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
            return;
        }
        try {
            socket.send(encoded);
        } catch {
            // Socket liveness owns reconnection. Missed events are recovered from the local cache.
        }
    };
}
