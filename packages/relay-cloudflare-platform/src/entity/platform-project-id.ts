import {
    PlatformControlPlaneError,
    type PlatformProjectLocationHint,
    type PlatformProjectPlacement,
} from "./platform-control-plane.ts";

const placements: ReadonlyMap<string, PlatformProjectPlacement> = new Map([
    ["wn", { locationHint: "wnam" }],
    ["en", { locationHint: "enam" }],
    ["sa", { locationHint: "sam" }],
    ["we", { locationHint: "weur" }],
    ["ee", { locationHint: "eeur" }],
    ["ap", { locationHint: "apac" }],
    ["an", { locationHint: "apac-ne" }],
    ["as", { locationHint: "apac-se" }],
    ["oc", { locationHint: "oc" }],
    ["af", { locationHint: "afr" }],
    ["me", { locationHint: "me" }],
]);

/** Platform IDs contain a locally mapped shard code followed by a 144-bit local identifier. */
export function encodePlatformProjectId(placement: PlatformProjectPlacement, localId: string): string {
    for (const [code, candidate] of placements) {
        if (candidate.locationHint === placement.locationHint) {
            return `prj_${code}_01_${localId}`;
        }
    }
    throw new PlatformControlPlaneError(
        "storage_location_unavailable",
        "The requested storage location is unavailable",
        400,
    );
}

export function decodePlatformProjectPlacement(projectId: string): PlatformProjectPlacement | null {
    const match = /^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_([A-Za-z0-9_-]{24})$/.exec(projectId);
    const code = match?.[1];
    if (match?.[0] !== projectId || code === undefined) {
        return null;
    }
    return placements.get(code) ?? null;
}

export function projectBucketLocation(locationHint: PlatformProjectLocationHint): "apac" | "wnam" {
    return locationHint === "apac" || locationHint === "apac-ne" || locationHint === "apac-se" || locationHint === "oc"
        ? "apac"
        : "wnam";
}

export function projectIdFromPrefixedValue(value: string): string | null {
    const match = /(?:^|_)(prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24})(?:[._]|$)/.exec(value);
    const projectId = match?.[1];
    return projectId !== undefined && decodePlatformProjectPlacement(projectId) !== null ? projectId : null;
}
