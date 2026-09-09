import type { TenantShardResolution } from "./tenant-sharding-directory.ts";

export interface BucketResolver {
    readonly resolve: (sharding: TenantShardResolution) => R2Bucket;
}
