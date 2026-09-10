import type { TenantShardingDirectory } from "@moxt-ai/mobius-relay-cloudflare";

export class StandaloneTenantShardingDirectory implements TenantShardingDirectory {
    readonly resolve: TenantShardingDirectory["resolve"] = async (tenantId, signal) => {
        signal.throwIfAborted();
        return { tenantId, tenantSharding: { hasShard: false } };
    };

    readonly resolveProject: TenantShardingDirectory["resolveProject"] = async (locator, signal) =>
        await this.resolve(locator.resolveHostingPlacement(), signal);
}
