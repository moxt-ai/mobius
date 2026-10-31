import type { RecordingLocation, SessionRecordingStorage } from "../storage/session-recording-storage.ts";

/**
 * Settles, once per Runtime and Session, whether the history lives in this object or in the Session's legacy object.
 * Before Recording was addressed by Runtime, a Session had one object, owned by the Runtime that wrote to it first;
 * that Runtime keeps its history there, and every other history starts here.
 */
export async function resolveRecordingLocation(
    storage: Pick<SessionRecordingStorage, "location" | "settleLocation">,
    runtimeId: string,
    legacyOwner: () => Promise<string | null>,
): Promise<RecordingLocation> {
    const settled = storage.location();
    if (settled !== null) {
        return settled;
    }
    return storage.settleLocation((await legacyOwner()) === runtimeId ? "legacy" : "local");
}
