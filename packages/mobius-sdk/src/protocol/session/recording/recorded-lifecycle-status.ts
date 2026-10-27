import type { SessionLiveEvent } from "../observability/event-log.ts";
import type { SessionRecordingStatus } from "./recording.ts";

/**
 * The last lifecycle observation in these events, for legacy summary and webhook consumers.
 * Missing events and other commands make this unsuitable as a current Session execution status.
 */
export function lastRecordedLifecycleStatus(events: readonly SessionLiveEvent[]): SessionRecordingStatus | null {
    let status: SessionRecordingStatus | null = null;
    for (const event of events) {
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        switch (event.payload.kind) {
            case "prompt.requested":
            case "prompt.started":
                status = "running";
                break;
            case "prompt.completed":
                status = "idle";
                break;
            case "prompt.failed":
            case "prompt.failed-before-start":
                status = "failed";
                break;
        }
    }
    return status;
}
