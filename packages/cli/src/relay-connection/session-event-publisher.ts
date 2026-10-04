import {
    AGENT_ACTIVITY_KIND,
    encodeDaemonToServiceMessage,
    encodeRecordedSessionEvent,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_FORKED_KIND,
    SESSION_READY_KIND,
    type SessionEventAcknowledgement,
    type SessionEventDeferred,
    type SessionEventRejected,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";

import { SessionEventQueue, SessionEventQueueCapacityError } from "./session-event-queue.ts";
import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

const SESSION_EVENT_REPLAY_WINDOW = 16;
const SESSION_EVENT_REPLAY_BYTE_LIMIT = 32 * 1024 * 1024;

type ConnectionState =
    | { readonly kind: "disconnected" }
    | {
          readonly delivery: "ephemeral" | "reliable";
          readonly kind: "connected";
          readonly socket: WebSocket;
      };

interface InFlightEvent {
    readonly byteLength: number;
}

function reservesSessionEventCapacity(event: RecordedSessionEvent): boolean {
    if (
        event.kind === SESSION_COMPLETED_KIND ||
        event.kind === SESSION_FAILED_KIND ||
        event.kind === SESSION_FORKED_KIND ||
        event.kind === SESSION_READY_KIND
    ) {
        return true;
    }
    return (
        event.kind === AGENT_ACTIVITY_KIND &&
        (event.activityType === "progress" || event.activityType === "reasoning") &&
        (event.status === "completed" || event.status === "failed")
    );
}

/** Retries pending events while this daemon lives; shutdown discards unacknowledged delivery. */
export class DaemonSessionEventPublisher {
    readonly #inFlight = new Map<string, InFlightEvent>();
    readonly #queue = new SessionEventQueue();
    readonly #reportedCapacityKinds = new Set<string>();
    readonly #timer: DaemonTimer;
    #connection: ConnectionState = { kind: "disconnected" };
    #deferredReplay: DaemonScheduledTask | null = null;
    #inFlightBytes = 0;

    constructor(timer: DaemonTimer) {
        this.#timer = timer;
    }

    readonly acknowledge = (acknowledgement: SessionEventAcknowledgement): void => {
        if (!this.#queue.remove(acknowledgement.eventId, acknowledgement.sessionId)) {
            return;
        }
        this.#removeInFlight(acknowledgement.eventId);
        this.#publishNextBatch();
    };

    readonly close = (): void => {
        this.#deferredReplay?.cancel();
        this.#deferredReplay = null;
        this.#connection = { kind: "disconnected" };
        this.#clearInFlight();
        this.#queue.clear();
    };

    readonly connect = (socket: WebSocket, delivery: "ephemeral" | "reliable"): void => {
        this.#connection = { delivery, kind: "connected", socket };
        this.#clearInFlight();
        this.#publishNextBatch();
    };

    readonly defer = (deferred: SessionEventDeferred): void => {
        if (!this.#inFlight.has(deferred.eventId)) {
            return;
        }
        this.#clearInFlight();
        if (this.#deferredReplay !== null) {
            return;
        }
        this.#deferredReplay = this.#timer.schedule(() => {
            this.#deferredReplay = null;
            this.#publishNextBatch();
        }, deferred.retryAfterMilliseconds);
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#connection.kind !== "connected" || this.#connection.socket !== socket) {
            return;
        }
        this.#connection = { kind: "disconnected" };
        this.#clearInFlight();
    };

    readonly publish = (sessionId: string, event: RecordedSessionEvent): void => {
        try {
            this.#queue.enqueueBatch(
                sessionId,
                [encodeRecordedSessionEvent(event)],
                reservesSessionEventCapacity(event),
            );
        } catch (error) {
            if (!(error instanceof SessionEventQueueCapacityError)) {
                throw error;
            }
            if (!this.#reportedCapacityKinds.has(event.kind)) {
                this.#reportedCapacityKinds.add(event.kind);
                console.warn(`Mobius daemon could not buffer "${event.kind}" because the Session event queue is full`);
            }
            return;
        }
        this.#publishNextBatch();
    };

    readonly publishBatch = (sessionId: string, events: readonly RecordedSessionEvent[]): void => {
        const critical = events.some(reservesSessionEventCapacity);
        this.#queue.enqueueBatch(sessionId, events.map(encodeRecordedSessionEvent), critical);
        this.#publishNextBatch();
    };

    readonly reject = (rejection: SessionEventRejected): void => {
        if (!this.#queue.remove(rejection.eventId, rejection.sessionId)) {
            return;
        }
        this.#removeInFlight(rejection.eventId);
        console.error(`Mobius Relay rejected Session event ${rejection.eventId} with code ${rejection.code}`);
        this.#publishNextBatch();
    };

    readonly #clearInFlight = (): void => {
        this.#inFlight.clear();
        this.#inFlightBytes = 0;
    };

    readonly #publishNextBatch = (): void => {
        if (this.#deferredReplay !== null || this.#connection.kind !== "connected") {
            return;
        }
        while (this.#inFlight.size < SESSION_EVENT_REPLAY_WINDOW) {
            const batch = this.#queue.pending(
                SESSION_EVENT_REPLAY_WINDOW - this.#inFlight.size,
                new Set(this.#inFlight.keys()),
            );
            let sent = 0;
            for (const envelope of batch) {
                const encoded = encodeDaemonToServiceMessage(
                    this.#connection.delivery === "reliable"
                        ? envelope
                        : {
                              kind: envelope.kind,
                              payload: envelope.payload,
                              sessionId: envelope.sessionId,
                          },
                );
                const byteLength = Buffer.byteLength(encoded, "utf8");
                if (this.#inFlightBytes + byteLength > SESSION_EVENT_REPLAY_BYTE_LIMIT) {
                    return;
                }
                if (!this.#send(encoded)) {
                    this.#clearInFlight();
                    return;
                }
                if (this.#connection.delivery === "ephemeral") {
                    this.#queue.remove(envelope.delivery.eventId, envelope.sessionId);
                    sent += 1;
                    continue;
                }
                this.#inFlight.set(envelope.delivery.eventId, { byteLength });
                this.#inFlightBytes += byteLength;
                sent += 1;
            }
            if (sent === 0) {
                return;
            }
        }
    };

    readonly #removeInFlight = (eventId: string): void => {
        const inFlight = this.#inFlight.get(eventId);
        if (inFlight === undefined) {
            return;
        }
        this.#inFlight.delete(eventId);
        this.#inFlightBytes -= inFlight.byteLength;
    };

    readonly #send = (encoded: string): boolean => {
        if (this.#connection.kind !== "connected" || this.#connection.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.#connection.socket.send(encoded);
            return true;
        } catch {
            return false;
        }
    };
}
