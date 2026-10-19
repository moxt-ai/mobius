import {
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionEventEnvelope,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-protocol";
import type { SessionRecording, SessionRecordingTarget } from "../../infra/session-recording.ts";
import { RuntimeMessageScheduler } from "./runtime-message-scheduler.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEADLINE_MILLISECONDS = 10_000;

interface SessionLane {
    readonly target: SessionRecordingTarget;
    readonly events: SessionLiveEvent[];
    /** Events were lost since the last delivery; the next delivered event carries the omission marker. */
    gap: boolean;
    draining: boolean;
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
    readonly #messages = new RuntimeMessageScheduler(4, 128);
    readonly #recording: SessionRecording;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #lanes = new Map<string, SessionLane>();
    #pendingBytes = 0;

    constructor(recording: SessionRecording, waitUntil: (operation: Promise<void>) => void) {
        this.#recording = recording;
        this.#waitUntil = waitUntil;
    }

    readonly publish = (target: SessionRecordingTarget, envelope: SessionEventEnvelope): void => {
        const laneKey = JSON.stringify([target.projectId, target.runtimeId, target.sessionId]);
        const lane = this.#lanes.get(laneKey) ?? { target, events: [], gap: false, draining: false };
        this.#lanes.set(laneKey, lane);
        const bytes = envelope.events.reduce((total, event) => total + eventBytes(event), 0);
        if (this.#pendingBytes + bytes > MAX_PENDING_BYTES) {
            console.warn("Recording event dropped", { code: "recording_capacity_exceeded" });
            lane.gap = true;
            return;
        }
        this.#pendingBytes += bytes;
        lane.events.push(...envelope.events);
        if (lane.draining) {
            return;
        }
        lane.draining = true;
        // Each delivery has its own deadline; waiting in the lane is bounded by the pending byte cap.
        const drain = this.#messages
            .run(laneKey, new AbortController().signal, async () => {
                await this.#drain(lane);
            })
            .catch(() => {
                // The scheduler refused or aborted the drain: nothing in the lane will be delivered.
                console.warn("Recording event dropped", { code: "recording_incomplete" });
                this.#discard(lane);
            })
            .finally(() => {
                if (lane.events.length === 0 && !lane.gap && this.#lanes.get(laneKey) === lane) {
                    this.#lanes.delete(laneKey);
                }
            });
        this.#waitUntil(drain);
    };

    #discard(lane: SessionLane): void {
        const dropped = lane.events.splice(0);
        this.#pendingBytes -= dropped.reduce((total, event) => total + eventBytes(event), 0);
        lane.gap = true;
        lane.draining = false;
    }

    async #drain(lane: SessionLane): Promise<void> {
        while (lane.events.length > 0) {
            const batch = lane.events.splice(0, SESSION_EVENT_BATCH_MAX_SIZE);
            const batchBytes = batch.reduce((total, event) => total + eventBytes(event), 0);
            const [first, ...rest] = lane.gap ? batch : [];
            const events =
                first === undefined ? batch : [{ ...first, mobiusMetadata: { omitted: true as const } }, ...rest];
            lane.gap = false;
            try {
                if (!(await this.#deliver(lane.target, events))) {
                    lane.gap = true;
                }
            } finally {
                this.#pendingBytes -= batchBytes;
            }
        }
        // Cleared in the same synchronous step as the empty check so a publish cannot append to a
        // lane that no drain will visit again.
        lane.draining = false;
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
