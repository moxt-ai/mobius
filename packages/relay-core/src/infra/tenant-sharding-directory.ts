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
    readonly resolve: (tenantId: string, signal: AbortSignal) => Promise<TenantContext>;
}
