import { PlatformControlPlaneError, type PlatformProjectPlacement } from "./platform-control-plane.ts";

const placements: ReadonlyMap<string, PlatformProjectPlacement> = new Map([
    ["a01", { d1ShardId: "apac-01", r2BucketId: "apac" }],
    ["a02", { d1ShardId: "apac-02", r2BucketId: "apac" }],
    ["w01", { d1ShardId: "wnam-01", r2BucketId: "wnam" }],
    ["w02", { d1ShardId: "wnam-02", r2BucketId: "wnam" }],
]);

/** Platform IDs contain a locally mapped shard code followed by a 144-bit local identifier. */
export function encodePlatformProjectId(placement: PlatformProjectPlacement, localId: string): string {
    for (const [code, candidate] of placements) {
        if (candidate.d1ShardId === placement.d1ShardId && candidate.r2BucketId === placement.r2BucketId) {
            return `prj_${code}_${localId}`;
        }
    }
    throw new PlatformControlPlaneError(
        "storage_location_unavailable",
        "The requested storage location is unavailable",
        400,
    );
}

export function decodePlatformProjectPlacement(projectId: string): PlatformProjectPlacement | null {
    const match = /^prj_([aw][0-9]{2})_[A-Za-z0-9_-]{24}$/.exec(projectId);
    const code = match?.[1];
    if (match?.[0] !== projectId || code === undefined) {
        return null;
    }
    return placements.get(code) ?? null;
}
