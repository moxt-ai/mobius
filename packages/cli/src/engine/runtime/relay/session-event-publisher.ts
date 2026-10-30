import {
    type DaemonToServiceMessage,
    encodeDaemonToServiceMessage,
    isPromptTerminal,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REPLAY_KIND,
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
const EMPTY_REPLAY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ events: [], kind: SESSION_EVENT_REPLAY_KIND }));
// How long sent output can be replayed after a reconnect. A connection can die without closing until the heartbeat
// notices, at most 30 seconds later; whatever was sent meanwhile is lost unless it is sent again.
const REPLAY_WINDOW_MILLISECONDS = 60_000;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;
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

interface SentBatch {
    readonly events: readonly SessionLiveEvent[];
    readonly bytes: number;
    readonly sentAt: number;
}

/**
 * Keeps unsent output in bounded memory across reconnects. Output sent within the replay window is sent again after a
 * reconnect, but only to a Relay that announced replay support, because the Relay may have lost it with the previous
 * connection.
 */
export class RuntimeSessionEventPublisher implements SessionEventSink {
    readonly #pending: PendingBatch[] = [];
    readonly #sent: SentBatch[] = [];
    readonly #awaitingFirstAnswer = new Map<string, { readonly commandId: string; readonly generationId: string }>();
    #pendingBytes = 0;
    #sentBytes = 0;
    #overflowReported = false;
    #pendingTask: ScheduledTask | null = null;
    #connection: PublisherConnection = { kind: "disconnected" };
    readonly #timer: Timer;

    constructor(timer: Timer) {
        this.#timer = timer;
    }

    /** Starts sending on a ready connection; `replay` is whether its Relay announced replay support. */
    readonly connect = (socket: WebSocket, { replay }: { readonly replay: boolean }): void => {
        if (this.#connection.kind === "closed") {
            return;
        }
        this.#connection = { kind: "connected", socket };
        if (replay) {
            this.replaySent(socket);
        }
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
        this.#sent.length = 0;
        this.#sentBytes = 0;
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
                isPromptTerminal(payload) &&
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
        let sent = 0;
        for (const batch of this.#pending) {
            const encoded = encodeDaemonToServiceMessage({ events: batch.events, kind: SESSION_EVENT_KIND });
            if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
                socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
                break;
            }
            // Only discard a batch after the local socket accepts it; cloud delivery remains best effort.
            try {
                socket.send(encoded);
                sent += 1;
                this.#pendingBytes -= batch.bytes;
                this.#sent.push({ events: batch.events, bytes: batch.bytes, sentAt: Date.now() });
                this.#sentBytes += batch.bytes;
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
                socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event handoff failed");
                break;
            }
        }
        this.#pending.splice(0, sent);
        if (this.#pending.length === 0) {
            this.#overflowReported = false;
        }
        this.forgetSent();
    };

    /** Drops sent output that left the replay window, oldest first, and keeps the rest within its byte bound. */
    private readonly forgetSent = (): void => {
        const now = Date.now();
        let forgotten = 0;
        for (const batch of this.#sent) {
            if (this.#sentBytes <= MAX_REPLAY_BYTES && now - batch.sentAt <= REPLAY_WINDOW_MILLISECONDS) {
                break;
            }
            this.#sentBytes -= batch.bytes;
            forgotten += 1;
        }
        this.#sent.splice(0, forgotten);
    };

    /**
     * Sends recently sent output again, oldest first, in frames within the live frame limits. Only the newest frames
     * that leave room in the socket buffer for the unsent tail are sent, so a replay never closes the connection for
     * backpressure. Recording stores each event once, so output the Relay did handle is not stored twice.
     */
    private readonly replaySent = (socket: WebSocket): void => {
        this.forgetSent();
        const frames: { readonly encoded: string; readonly bytes: number }[] = [];
        const addFrame = (events: readonly SessionLiveEvent[]): void => {
            const encoded = encodeDaemonToServiceMessage({ events, kind: SESSION_EVENT_REPLAY_KIND });
            frames.push({ encoded, bytes: Buffer.byteLength(encoded, "utf8") });
        };
        let events: SessionLiveEvent[] = [];
        let bytes = EMPTY_REPLAY_ENVELOPE_BYTES;
        for (const batch of this.#sent) {
            const batchBytes = batch.bytes - EMPTY_ENVELOPE_BYTES;
            if (
                events.length > 0 &&
                (events.length + batch.events.length > SESSION_EVENT_BATCH_MAX_SIZE ||
                    bytes + batchBytes > MAX_EVENT_BATCH_BYTES)
            ) {
                addFrame(events);
                events = [];
                bytes = EMPTY_REPLAY_ENVELOPE_BYTES;
            }
            events.push(...batch.events);
            bytes += batchBytes;
        }
        if (events.length > 0) {
            addFrame(events);
        }
        let room = MAX_BUFFERED_BYTES - socket.bufferedAmount - this.#pendingBytes;
        let first = frames.length;
        for (const frame of [...frames].reverse()) {
            if (frame.bytes > room) {
                break;
            }
            room -= frame.bytes;
            first -= 1;
        }
        for (const { encoded } of frames.slice(first)) {
            try {
                socket.send(encoded);
            } catch {
                // The live handoff that follows notices a failed connection.
                return;
            }
        }
    };
}
