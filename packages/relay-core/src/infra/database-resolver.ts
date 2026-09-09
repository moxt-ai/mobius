import type { SqlDatabase } from "./sql-database.ts";
import type { TenantShardResolution } from "./tenant-sharding-directory.ts";

export interface DatabaseResolver {
    readonly resolve: (sharding: TenantShardResolution) => SqlDatabase;
}
