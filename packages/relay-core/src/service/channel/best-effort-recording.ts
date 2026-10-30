import {
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionWireEnvelope,
    type SessionWireEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type {
    SessionRecording,
    SessionRecordingBatchResult,
    SessionRecordingScope,
    SessionRecordingTarget,
} from "../../infra/session-recording.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEADLINE_MILLISECONDS = 10_000;
const DELIVERY_CONCURRENCY = 4;
const MAX_DELIVERY_BYTES = 1024 * 1024;
// Each Session needs a separate storage request within the delivery deadline.
// Keep recovery bursts in small independent deliveries so their tail can make progress.
const MAX_DELIVERY_SESSIONS = 32;
// How long the Relay waits before repeating a Session's first, second and third failed deliveries in a row. A
// failure that can pass, such as Recording restarting for a deployment, has usually passed by then. A delivery
// that failed or timed out may still have committed, so it is repeated only to a Recording that stores each event
// once.
const RETRY_BACKOFF_MILLISECONDS = [1_000, 2_000, 4_000];

type DeliveryFailure =
    | Extract<SessionRecordingBatchResult, { readonly kind: "failed" }>["code"]
    | "recording_incomplete";

/** Whether delivering the same events again can succeed: Recording failed, or did not answer in time. */
function retryable(failure: DeliveryFailure): boolean {
    return failure === "write_failed" || failure === "recording_incomplete";
}

function laneKey(target: SessionRecordingTarget): string {
    return JSON.stringify([target.projectId, target.runtimeId, target.sessionId]);
}

interface BufferedEvent {
    readonly event: SessionWireEvent;
    readonly bytes: number;
}
interface Batch {
    readonly events: readonly SessionWireEvent[];
    readonly bytes: number;
}
interface SessionLane {
    readonly target: SessionRecordingTarget;
    readonly events: BufferedEvent[];
    /** A batch whose delivery failed; it is delivered again before any later event of the Session. */
    retry: Batch | null;
    /** The Session's failed deliveries since its last recorded one. */
    failures: number;
    /** The next recorded event exposes any earlier capacity or delivery loss. */
    gap: boolean;
    state: "idle" | "ready" | "delivering" | "backing-off";
}
interface Delivery extends Batch {
    readonly lane: SessionLane;
}

/** Recording never blocks live fanout. Lanes preserve Session order across bounded multi-Session writes. */
export class BestEffortRecording {
    readonly #recording: SessionRecording;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #lanes = new Map<string, SessionLane>();
    readonly #ready = new Set<SessionLane>();
    #active = 0;
    #pendingBytes = 0;

    constructor(recording: SessionRecording, waitUntil: (operation: Promise<void>) => void) {
        this.#recording = recording;
        this.#waitUntil = waitUntil;
    }

    readonly publish = (scope: SessionRecordingScope, envelope: SessionWireEnvelope): void => {
        const grouped = new Map<string, BufferedEvent[]>();
        for (const event of envelope.events) {
            const events = grouped.get(event.sessionId) ?? [];
            events.push({ event, bytes: new TextEncoder().encode(JSON.stringify(event)).byteLength });
            grouped.set(event.sessionId, events);
        }
        for (const [sessionId, events] of grouped) {
            const target = { ...scope, sessionId };
            const lane: SessionLane = this.#lanes.get(laneKey(target)) ?? {
                target,
                events: [],
                retry: null,
                failures: 0,
                gap: false,
                state: "idle",
            };
            this.#lanes.set(laneKey(target), lane);
            const bytes = events.reduce((sum, item) => sum + item.bytes, 0);
            if (this.#pendingBytes + bytes > MAX_PENDING_BYTES) {
                console.warn("Recording event dropped", { code: "recording_capacity_exceeded" });
                lane.gap = true;
                continue;
            }
            this.#pendingBytes += bytes;
            lane.events.push(...events);
            this.#enqueue(lane);
        }
        // All Sessions from the incoming envelope are ready before any delivery starts. No extra timer.
        this.#pump();
    };

    #enqueue(lane: SessionLane): void {
        if (lane.state !== "idle" || (lane.events.length === 0 && lane.retry === null)) {
            return;
        }
        lane.state = "ready";
        this.#ready.add(lane);
    }

    #pump(): void {
        while (this.#active < DELIVERY_CONCURRENCY) {
            const first = this.#ready.values().next().value;
            if (first === undefined) {
                return;
            }
            const scope: SessionRecordingScope = first.target;
            const deliveries: Delivery[] = [];
            let bytes = 0;
            let count = 0;
            for (const lane of this.#ready) {
                if (lane.target.projectId !== scope.projectId || lane.target.runtimeId !== scope.runtimeId) {
                    continue;
                }
                if (
                    deliveries.length >= MAX_DELIVERY_SESSIONS ||
                    count >= SESSION_EVENT_BATCH_MAX_SIZE ||
                    bytes >= MAX_DELIVERY_BYTES
                ) {
                    break;
                }
                const retry = lane.retry;
                if (retry !== null) {
                    // The batch fit one delivery when it was first sent, so it is repeated whole and unchanged.
                    if (
                        deliveries.length > 0 &&
                        (count + retry.events.length > SESSION_EVENT_BATCH_MAX_SIZE ||
                            bytes + retry.bytes > MAX_DELIVERY_BYTES)
                    ) {
                        break;
                    }
                    lane.retry = null;
                    lane.state = "delivering";
                    this.#ready.delete(lane);
                    deliveries.push({ lane, ...retry });
                    bytes += retry.bytes;
                    count += retry.events.length;
                    continue;
                }
                let length = 0;
                let laneBytes = 0;
                for (const item of lane.events) {
                    if (
                        count + length >= SESSION_EVENT_BATCH_MAX_SIZE ||
                        (count + length > 0 && bytes + laneBytes + item.bytes > MAX_DELIVERY_BYTES)
                    ) {
                        break;
                    }
                    laneBytes += item.bytes;
                    length += 1;
                }
                if (length === 0) {
                    break;
                }
                const batch = lane.events.splice(0, length).map((item) => item.event);
                const [head, ...tail] = lane.gap ? batch : [];
                const events: readonly SessionWireEvent[] =
                    head === undefined
                        ? batch
                        : [{ ...head, mobiusMetadata: { ...head.mobiusMetadata, omitted: true } }, ...tail];
                lane.gap = false;
                lane.state = "delivering";
                this.#ready.delete(lane);
                deliveries.push({ lane, events, bytes: laneBytes });
                bytes += laneBytes;
                count += length;
            }
            this.#active += 1;
            const delivery = this.#deliver(
                scope,
                deliveries.flatMap((item) => item.events),
            ).then((results) => {
                try {
                    for (const item of deliveries) {
                        this.#settle(
                            item,
                            results.find((result) => result.sessionId === item.lane.target.sessionId),
                        );
                    }
                } finally {
                    this.#active -= 1;
                    this.#pump();
                }
            });
            this.#waitUntil(delivery);
        }
    }

    /**
     * Applies one Session's delivery result. A failure that can pass repeats the batch after a backoff, before any
     * later event of the Session, if Recording stores each event once. Any other failure drops the batch, as does
     * a failure that outlasts the retries; after that, the Session's failed deliveries are dropped at once until one
     * is recorded, so a Session that Recording keeps refusing cannot hold the shared buffer.
     */
    #settle(delivery: Delivery, result: SessionRecordingBatchResult | undefined): void {
        const { lane } = delivery;
        const failure: DeliveryFailure | null =
            result === undefined ? "recording_incomplete" : result.kind === "failed" ? result.code : null;
        lane.failures = failure === null ? 0 : lane.failures + 1;
        const backoff = RETRY_BACKOFF_MILLISECONDS[lane.failures - 1];
        if (failure !== null && retryable(failure) && backoff !== undefined) {
            // The batch keeps its bytes, and its Session keeps its place, until it is repeated or dropped.
            lane.state = "backing-off";
            this.#waitUntil(this.#retryLater(delivery, failure, backoff));
            return;
        }
        this.#release(delivery, failure);
    }

    /**
     * Repeats a failed batch after the backoff. A write that failed or timed out may still have committed, so a
     * Recording that does not store each event once never receives it again: the batch is dropped at once, as it
     * was before the Relay retried.
     */
    async #retryLater(delivery: Delivery, failure: DeliveryFailure, backoff: number): Promise<void> {
        const { lane, events, bytes } = delivery;
        if (await this.#storesEachEventOnce()) {
            console.warn("Recording delivery will be retried", { code: failure, retry: lane.failures });
            await new Promise((resolve) => setTimeout(resolve, backoff));
            lane.retry = { events, bytes };
            lane.state = "idle";
            this.#enqueue(lane);
        } else {
            this.#release(delivery, failure);
        }
        this.#pump();
    }

    /** Frees a settled batch's place; a failed batch is dropped, and the Session's next recorded event says so. */
    #release({ lane, bytes }: Delivery, failure: DeliveryFailure | null): void {
        if (failure !== null) {
            lane.gap = true;
            console.warn("Recording event dropped", { code: failure });
        }
        this.#pendingBytes -= bytes;
        lane.state = "idle";
        this.#enqueue(lane);
        if (lane.events.length === 0 && !lane.gap) {
            this.#lanes.delete(laneKey(lane.target));
        }
    }

    /** Whether Recording says it stores each event once; no answer within the deadline counts as no. */
    async #storesEachEventOnce(): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Recording deadline expired", "TimeoutError")),
            DEADLINE_MILLISECONDS,
        );
        try {
            return await this.#recording.storesEachEventOnce(controller.signal);
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async #deliver(
        scope: SessionRecordingScope,
        events: readonly SessionWireEvent[],
    ): Promise<readonly SessionRecordingBatchResult[]> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Recording deadline expired", "TimeoutError")),
            DEADLINE_MILLISECONDS,
        );
        try {
            return await this.#recording.deliverBatch(scope, { events, kind: SESSION_EVENT_KIND }, controller.signal);
        } catch {
            return [];
        } finally {
            clearTimeout(timer);
        }
    }
}
