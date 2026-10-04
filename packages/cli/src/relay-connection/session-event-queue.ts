import { randomUUID } from "node:crypto";

import {
    encodeSessionEventEnvelope,
    type ReliableSessionEventEnvelope,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-protocol";

const STANDARD_EVENT_BYTES = 96 * 1024 * 1024;
const CRITICAL_EVENT_BYTES = 128 * 1024 * 1024;

export class SessionEventQueueCapacityError extends Error {
    readonly code = "session_event_queue_full";

    constructor() {
        super("The in-memory Session event queue is full");
        this.name = "SessionEventQueueCapacityError";
    }
}

/** Pending delivery belongs to this daemon lifetime; a new daemon starts a new stream. */
export class SessionEventQueue {
    readonly #streamId = randomUUID();
    readonly #events = new Map<
        string,
        {
            readonly envelope: ReliableSessionEventEnvelope;
            readonly byteLength: number;
        }
    >();
    #nextSourceSeq = 1;
    #totalBytes = 0;

    readonly enqueueBatch = (sessionId: string, payloads: readonly string[], critical: boolean): void => {
        if (payloads.length < 1 || payloads.length > 32) {
            throw new Error("A Session event batch must contain between 1 and 32 events");
        }
        if (!Number.isSafeInteger(this.#nextSourceSeq + payloads.length)) {
            throw new Error("The Session event source sequence is exhausted");
        }
        const entries = payloads.map((payload, index) => {
            const envelope: ReliableSessionEventEnvelope = {
                delivery: {
                    eventId: randomUUID(),
                    kind: "reliable",
                    sourceSeq: (this.#nextSourceSeq + index).toString(),
                    streamId: this.#streamId,
                },
                kind: SESSION_EVENT_KIND,
                payload,
                sessionId,
            };
            return { envelope, byteLength: Buffer.byteLength(encodeSessionEventEnvelope(envelope), "utf8") };
        });
        const byteLength = entries.reduce((total, entry) => total + entry.byteLength, 0);
        if (this.#totalBytes + byteLength > (critical ? CRITICAL_EVENT_BYTES : STANDARD_EVENT_BYTES)) {
            throw new SessionEventQueueCapacityError();
        }
        for (const entry of entries) {
            this.#events.set(entry.envelope.delivery.eventId, entry);
        }
        this.#nextSourceSeq += entries.length;
        this.#totalBytes += byteLength;
    };

    readonly pending = (
        limit: number,
        excludedEventIds: ReadonlySet<string>,
    ): readonly ReliableSessionEventEnvelope[] => {
        const result: ReliableSessionEventEnvelope[] = [];
        for (const [eventId, entry] of this.#events) {
            if (!excludedEventIds.has(eventId)) {
                result.push(entry.envelope);
                if (result.length === limit) {
                    break;
                }
            }
        }
        return result;
    };

    readonly remove = (eventId: string, sessionId: string): boolean => {
        const entry = this.#events.get(eventId);
        if (entry === undefined || entry.envelope.sessionId !== sessionId) {
            return false;
        }
        this.#events.delete(eventId);
        this.#totalBytes -= entry.byteLength;
        return true;
    };

    readonly clear = (): void => {
        this.#events.clear();
        this.#totalBytes = 0;
    };
}
