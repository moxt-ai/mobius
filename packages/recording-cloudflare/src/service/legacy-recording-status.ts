import {
    lastRecordedLifecycleStatus,
    type SessionRecordingStatus,
    sessionLiveEventSchema,
} from "@moxt-ai/mobius-sdk/protocol";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";

type LegacyRecordingStatusRead =
    | { readonly kind: "available"; readonly status: SessionRecordingStatus }
    | { readonly kind: "not_found" }
    | { readonly kind: "unavailable" };

/** Reconstructs the V1 compatibility field on demand; no execution state is stored in the directory. */
export function readLegacyRecordingStatus(
    storage: Pick<SessionRecordingStorage, "records" | "batchesNewestFirst">,
    target: { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string },
): LegacyRecordingStatusRead {
    if (!storage.records(target.projectId, target.runtimeId, target.sessionId)) {
        return { kind: "not_found" };
    }
    for (const batch of storage.batchesNewestFirst()) {
        const status = lastRecordedLifecycleStatus(
            batch.events.flatMap((event) => {
                const parsed = sessionLiveEventSchema.safeParse(event);
                return parsed.success ? [parsed.data] : [];
            }),
        );
        if (status !== null) {
            return { kind: "available", status };
        }
    }
    // Older directories can outlive their recorded lifecycle events. Do not invent an idle outcome.
    return { kind: "unavailable" };
}
