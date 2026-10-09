import type { SessionEventEnvelopeV2 } from "@moxt-ai/mobius-protocol";
import type { SessionRecording, SessionRecordingTarget } from "../../infra/session-recording.ts";
import { RuntimeMessageScheduler } from "./runtime-message-scheduler.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEADLINE_MILLISECONDS = 10_000;

/** An isolated, bounded recording consumer. Failure never holds up the live broadcast. */
export class BestEffortRecording {
    readonly #messages = new RuntimeMessageScheduler(4, 128);
    readonly #recording: SessionRecording;
    readonly #waitUntil: (operation: Promise<void>) => void;
    #pendingBytes = 0;

    constructor(recording: SessionRecording, waitUntil: (operation: Promise<void>) => void) {
        this.#recording = recording;
        this.#waitUntil = waitUntil;
    }

    readonly publish = (target: SessionRecordingTarget, envelope: SessionEventEnvelopeV2): void => {
        const bytes = new TextEncoder().encode(JSON.stringify(envelope.events)).byteLength;
        if (this.#pendingBytes + bytes > MAX_PENDING_BYTES) {
            console.warn("Recording event dropped", { code: "recording_capacity_exceeded" });
            return;
        }
        this.#pendingBytes += bytes;
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Recording deadline expired", "TimeoutError")),
            DEADLINE_MILLISECONDS,
        );
        const operation = this.#messages
            .run(
                JSON.stringify([target.projectId, target.runtimeId, target.sessionId]),
                controller.signal,
                async () => {
                    const result = await this.#recording.deliver(target, envelope, controller.signal);
                    if (result.kind === "failed") {
                        console.warn("Recording event dropped", { code: result.code });
                    }
                },
            )
            .catch(() => {
                console.warn("Recording event dropped", { code: "recording_incomplete" });
            })
            .finally(() => {
                clearTimeout(timer);
                this.#pendingBytes -= bytes;
            });
        this.#waitUntil(operation);
    };
}
