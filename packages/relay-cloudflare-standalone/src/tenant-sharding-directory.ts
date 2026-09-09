import type { TenantShardingDirectory } from "@moxt-ai/mobius-relay-cloudflare";

export class StandaloneTenantShardingDirectory implements TenantShardingDirectory {
    readonly resolve: TenantShardingDirectory["resolve"] = async (tenantId, signal) => {
        signal.throwIfAborted();
        return { tenantId, tenantSharding: { hasShard: false } };
    };
}
