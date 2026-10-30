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

interface BufferedEvent {
    readonly event: SessionWireEvent;
    readonly bytes: number;
}
interface SessionLane {
    readonly target: SessionRecordingTarget;
    readonly events: BufferedEvent[];
    /** The next recorded event exposes any earlier capacity or delivery loss. */
    gap: boolean;
    state: "idle" | "ready" | "delivering";
}
interface Delivery {
    readonly lane: SessionLane;
    readonly events: readonly SessionWireEvent[];
    readonly bytes: number;
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
            const laneKey = JSON.stringify([scope.projectId, scope.runtimeId, sessionId]);
            const lane: SessionLane = this.#lanes.get(laneKey) ?? {
                target: { ...scope, sessionId },
                events: [],
                gap: false,
                state: "idle",
            };
            this.#lanes.set(laneKey, lane);
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
        if (lane.state !== "idle" || lane.events.length === 0) {
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
            )
                .then((results) => {
                    for (const { lane } of deliveries) {
                        const result = results.find((item) => item.sessionId === lane.target.sessionId);
                        if (result === undefined || result.kind === "failed") {
                            lane.gap = true;
                            console.warn("Recording event dropped", {
                                code: result?.kind === "failed" ? result.code : "recording_incomplete",
                            });
                        }
                    }
                })
                .finally(() => {
                    this.#active -= 1;
                    for (const { lane, bytes } of deliveries) {
                        this.#pendingBytes -= bytes;
                        lane.state = "idle";
                        this.#enqueue(lane);
                        if (lane.events.length === 0 && !lane.gap) {
                            this.#lanes.delete(
                                JSON.stringify([lane.target.projectId, lane.target.runtimeId, lane.target.sessionId]),
                            );
                        }
                    }
                    this.#pump();
                });
            this.#waitUntil(delivery);
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
