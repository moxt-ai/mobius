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
import type { SessionEventSink } from "../../session/api/session-api.ts";
import type { ScheduledTask, Timer } from "../../util/timer.ts";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BATCH_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// Browser-compatible WebSocket clients may initiate only 1000 or application close codes.
const LOCAL_BACKPRESSURE_CLOSE_CODE = 4009;
const EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ events: [], kind: SESSION_EVENT_KIND }));
export const SESSION_EVENT_BATCH_WINDOW_MILLISECONDS = 100;

type PublisherConnection =
    | { readonly kind: "disconnected" }
    | { readonly kind: "connected"; readonly socket: WebSocket }
    | { readonly kind: "closed" };

interface PendingBatch {
    readonly events: SessionLiveEvent[];
    readonly firstAnswers: {
        readonly sessionId: string;
        readonly commandId: string;
        readonly eventId: string;
        readonly observedAt: number;
        readonly publishedAt: number;
    }[];
    bytes: number;
}

/** Keeps unsent output in bounded memory across reconnects. Sent events are never replayed. */
export class RuntimeSessionEventPublisher implements SessionEventSink {
    readonly #pending: PendingBatch[] = [];
    readonly #awaitingFirstAnswer = new Map<string, { readonly commandId: string; readonly generationId: string }>();
    #pendingBytes = 0;
    #overflowReported = false;
    #pendingTask: ScheduledTask | null = null;
    #connection: PublisherConnection = { kind: "disconnected" };
    readonly #timer: Timer;

    constructor(timer: Timer) {
        this.#timer = timer;
    }

    readonly connect = (socket: WebSocket): void => {
        if (this.#connection.kind === "closed") {
            return;
        }
        this.#connection = { kind: "connected", socket };
        // Hand off the unsent tail before a new command can publish newer events.
        this.flushEvents(socket);
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#connection.kind === "connected" && this.#connection.socket === socket) {
            this.#connection = { kind: "disconnected" };
            this.cancelFlush();
        }
    };

    readonly close = (): void => {
        this.#connection = { kind: "closed" };
        this.cancelFlush();
        this.#pending.length = 0;
        this.#pendingBytes = 0;
        this.#awaitingFirstAnswer.clear();
    };

    readonly flush = (): void => {
        if (this.#connection.kind === "connected") {
            this.flushEvents(this.#connection.socket);
        }
    };

    readonly publishOperationFailure = (sessionId: string, requestId: string, code: string, message: string): void => {
        this.#send({ kind: "session.operation.failed", sessionId, requestId, code, message });
    };
    readonly publishStatus = (event: SessionStatusChangedEvent): void => this.#send(event);
    readonly publishInfo = (event: SessionInfoUpdatedEvent): void => this.#send(event);
    readonly publishClosed = (event: SessionCloseNoticeEvent): void => {
        this.#awaitingFirstAnswer.delete(event.sessionId);
        this.#send(event);
    };

    readonly #send = (message: DaemonToServiceMessage): void => {
        const connection = this.#connection;
        if (connection.kind !== "connected" || connection.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const socket = connection.socket;
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
        if (this.#connection.kind === "closed") {
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
        let batch = this.#pending.at(-1);
        const newBatch =
            batch === undefined ||
            batch.events.length >= SESSION_EVENT_BATCH_MAX_SIZE ||
            batch.bytes + bytes > MAX_EVENT_BATCH_BYTES;
        const additionalBytes = bytes + (newBatch ? EMPTY_ENVELOPE_BYTES : 0);
        if (this.#pendingBytes + additionalBytes > MAX_PENDING_BYTES) {
            if (!this.#overflowReported) {
                this.#overflowReported = true;
                console.warn("Live Session output exceeded the pending buffer limit", {
                    code: "live_event_buffer_full",
                    sessionId: event.sessionId,
                    eventId: event.eventId,
                    maximumBytes: MAX_PENDING_BYTES,
                });
            }
            return;
        }
        if (batch === undefined || newBatch) {
            batch = { events: [], firstAnswers: [], bytes: EMPTY_ENVELOPE_BYTES };
            this.#pending.push(batch);
        }
        batch.events.push(event);
        batch.bytes += bytes;
        this.#pendingBytes += additionalBytes;
        const awaiting = this.#awaitingFirstAnswer.get(event.sessionId);
        const firstAnswer = this.#consumeFirstAnswer(event);
        if (firstAnswer && awaiting !== undefined) {
            batch.firstAnswers.push({
                sessionId: event.sessionId,
                commandId: awaiting.commandId,
                eventId: event.eventId,
                observedAt: Date.now(),
                publishedAt: performance.now(),
            });
        }
        const connection = this.#connection;
        if (connection.kind !== "connected" || connection.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const socket = connection.socket;
        if (
            firstAnswer ||
            this.#pending.length > 1 ||
            batch.events.length >= SESSION_EVENT_BATCH_MAX_SIZE ||
            batch.bytes >= MAX_EVENT_BATCH_BYTES
        ) {
            this.flushEvents(socket);
            return;
        }
        this.#pendingTask ??= this.#timer.schedule(
            () => this.flushEvents(socket),
            SESSION_EVENT_BATCH_WINDOW_MILLISECONDS,
        );
    };

    readonly #consumeFirstAnswer = (event: SessionLiveEvent): boolean => {
        if (event.type === "lifecycle-metadata") {
            const payload = event.payload;
            if (payload.kind === "prompt.started") {
                this.#awaitingFirstAnswer.set(event.sessionId, {
                    commandId: payload.commandId,
                    generationId: event.sessionGenerationId,
                });
            } else if (
                (payload.kind === "prompt.completed" ||
                    payload.kind === "prompt.failed" ||
                    payload.kind === "prompt.failed-before-start") &&
                this.#awaitingFirstAnswer.get(event.sessionId)?.commandId === payload.commandId &&
                this.#awaitingFirstAnswer.get(event.sessionId)?.generationId === event.sessionGenerationId
            ) {
                this.#awaitingFirstAnswer.delete(event.sessionId);
            }
            return false;
        }
        if (
            event.type !== "acp" ||
            event.payload.sessionUpdate !== "agent_message_chunk" ||
            event.payload.content.type !== "text" ||
            event.payload.content.text.length === 0 ||
            this.#awaitingFirstAnswer.get(event.sessionId)?.generationId !== event.sessionGenerationId
        ) {
            return false;
        }
        this.#awaitingFirstAnswer.delete(event.sessionId);
        return true;
    };

    private readonly cancelFlush = (): void => {
        this.#pendingTask?.cancel();
        this.#pendingTask = null;
    };

    private readonly flushEvents = (socket: WebSocket): void => {
        this.cancelFlush();
        const connection = this.#connection;
        if (connection.kind !== "connected" || connection.socket !== socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        let attempted = 0;
        for (const batch of this.#pending) {
            const encoded = encodeDaemonToServiceMessage({ events: batch.events, kind: SESSION_EVENT_KIND });
            if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
                socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
                break;
            }
            // Once handed to the socket, a batch cannot be safely resent without acknowledgements.
            attempted += 1;
            this.#pendingBytes -= batch.bytes;
            try {
                socket.send(encoded);
                for (const answer of batch.firstAnswers) {
                    console.info(
                        JSON.stringify({
                            event: "runtime-first-answer-handoff-timing",
                            sessionId: answer.sessionId,
                            commandId: answer.commandId,
                            eventId: answer.eventId,
                            observedAt: answer.observedAt,
                            handedOffAt: Date.now(),
                            publishToHandoffMs: performance.now() - answer.publishedAt,
                        }),
                    );
                }
            } catch {
                console.warn("Live Session output could not be sent", { code: "live_event_send_failed" });
                break;
            }
        }
        this.#pending.splice(0, attempted);
        if (this.#pending.length === 0) {
            this.#overflowReported = false;
        }
    };
}
