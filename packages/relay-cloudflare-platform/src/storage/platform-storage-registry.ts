import { isProjectLocationHint } from "@moxt-ai/mobius-sdk/protocol";
import type { PlatformProjectPlacement, PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import { projectBucketLocation } from "../entity/platform-project-id.ts";

export interface PlatformStorageBindings {
    readonly R2_BUCKET_WNAM?: R2Bucket;
    readonly R2_BUCKET_APAC?: R2Bucket;
}

function platformBucket(bindings: PlatformStorageBindings, id: string): R2Bucket | undefined {
    return id === "apac" ? bindings.R2_BUCKET_APAC : id === "wnam" ? bindings.R2_BUCKET_WNAM : undefined;
}

export class PlatformStorageRegistry implements PlatformProjectPlacementRegistry {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly supports = (placement: PlatformProjectPlacement): boolean =>
        platformBucket(this.#bindings, projectBucketLocation(placement.locationHint)) !== undefined;

    readonly resolveLocationHint = (locationHint: string): PlatformProjectPlacement | null =>
        isProjectLocationHint(locationHint) &&
        platformBucket(this.#bindings, projectBucketLocation(locationHint)) !== undefined
            ? { locationHint }
            : null;
}
