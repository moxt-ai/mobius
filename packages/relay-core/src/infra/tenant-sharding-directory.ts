import type { ProjectStorageLocator } from "../entity/do/session.ts";

export type TenantShardResolution =
    | { readonly hasShard: false }
    | {
          readonly hasShard: true;
          readonly shard: {
              readonly d1ShardId: string;
              readonly r2BucketId: string;
              readonly revision: number;
          };
      };

export interface TenantContext {
    readonly tenantId: string;
    readonly tenantSharding: TenantShardResolution;
}

export interface TenantShardingDirectory {
    readonly resolveProject: (locator: ProjectStorageLocator, signal: AbortSignal) => Promise<TenantContext>;
    readonly resolve: (tenantId: string, signal: AbortSignal) => Promise<TenantContext>;
}
