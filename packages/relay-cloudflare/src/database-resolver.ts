import type { TenantShardResolution } from "./tenant-sharding-directory.ts";

export interface DatabaseResolver {
    readonly resolve: (sharding: TenantShardResolution) => D1Database;
}
