import type { ProjectStoragePlacement } from "./project-storage-directory.ts";

export interface BucketResolver {
    readonly resolve: (sharding: ProjectStoragePlacement) => R2Bucket;
}
