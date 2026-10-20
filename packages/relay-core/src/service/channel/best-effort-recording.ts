import {
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionEventEnvelope,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { SessionRecording, SessionRecordingTarget } from "../../infra/session-recording.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEADLINE_MILLISECONDS = 10_000;
const DELIVERY_CONCURRENCY = 4;
const MAX_DELIVERY_BYTES = 1024 * 1024;

interface BufferedEvent {
    readonly event: SessionLiveEvent;
    readonly bytes: number;
}

interface SessionLane {
    readonly target: SessionRecordingTarget;
    readonly events: BufferedEvent[];
    /** Events were lost since the last delivery; the next delivered event carries the omission marker. */
    gap: boolean;
    state: "idle" | "ready" | "delivering";
}

function eventBytes(event: SessionLiveEvent): number {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

/**
 * An isolated, bounded recording consumer. Failure never holds up the live broadcast.
 *
 * A streaming answer arrives as hundreds of tiny envelopes. Each Session owns one lane that coalesces
 * consecutive envelopes into a single delivery, so a slow write grows a byte-bounded buffer instead of a
 * queue of per-envelope tasks that overflows and drops text. Events that are still lost (capacity,
 * deadline, write failure) mark the next recorded event as `omitted` so readers can see the hole.
 */
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

    readonly publish = (target: SessionRecordingTarget, envelope: SessionEventEnvelope): void => {
        const laneKey = JSON.stringify([target.projectId, target.runtimeId, target.sessionId]);
        const lane: SessionLane = this.#lanes.get(laneKey) ?? { target, events: [], gap: false, state: "idle" };
        this.#lanes.set(laneKey, lane);
        const events = envelope.events.map((event) => ({ event, bytes: eventBytes(event) }));
        const bytes = events.reduce((total, event) => total + event.bytes, 0);
        if (this.#pendingBytes + bytes > MAX_PENDING_BYTES) {
            console.warn("Recording event dropped", { code: "recording_capacity_exceeded" });
            lane.gap = true;
            return;
        }
        this.#pendingBytes += bytes;
        lane.events.push(...events);
        this.#enqueue(lane);
        this.#pump();
    };

    #enqueue(lane: SessionLane): void {
        if (lane.state !== "idle" || lane.events.length === 0) {
            return;
        }
        lane.state = "ready";
        this.#ready.add(lane);
    }

    #pump(): void {
        while (this.#active < DELIVERY_CONCURRENCY) {
            const lane = this.#ready.values().next().value;
            if (lane === undefined) {
                return;
            }
            this.#ready.delete(lane);
            lane.state = "delivering";
            this.#active += 1;
            let count = 0;
            let batchBytes = 0;
            for (const item of lane.events) {
                if (
                    count >= SESSION_EVENT_BATCH_MAX_SIZE ||
                    (count > 0 && batchBytes + item.bytes > MAX_DELIVERY_BYTES)
                ) {
                    break;
                }
                batchBytes += item.bytes;
                count += 1;
            }
            const batch = lane.events.splice(0, count).map((item) => item.event);
            const [first, ...rest] = lane.gap ? batch : [];
            const events =
                first === undefined ? batch : [{ ...first, mobiusMetadata: { omitted: true as const } }, ...rest];
            lane.gap = false;
            const delivery = this.#deliver(lane.target, events)
                .then((recorded) => {
                    if (!recorded) {
                        lane.gap = true;
                    }
                })
                .finally(() => {
                    this.#pendingBytes -= batchBytes;
                    this.#active -= 1;
                    lane.state = "idle";
                    // Rejoin at the tail after each bounded batch. A hot Session cannot retain
                    // a delivery slot while other Sessions are waiting for their first write.
                    this.#enqueue(lane);
                    if (lane.events.length === 0 && !lane.gap) {
                        this.#lanes.delete(
                            JSON.stringify([lane.target.projectId, lane.target.runtimeId, lane.target.sessionId]),
                        );
                    }
                    this.#pump();
                });
            this.#waitUntil(delivery);
        }
    }

    async #deliver(target: SessionRecordingTarget, events: readonly SessionLiveEvent[]): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Recording deadline expired", "TimeoutError")),
            DEADLINE_MILLISECONDS,
        );
        try {
            const result = await this.#recording.deliver(
                target,
                { events, kind: SESSION_EVENT_KIND },
                controller.signal,
            );
            if (result.kind === "failed") {
                console.warn("Recording event dropped", { code: result.code });
                return false;
            }
            return true;
        } catch {
            console.warn("Recording event dropped", { code: "recording_incomplete" });
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
