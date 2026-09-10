import {
    D1DatabaseAdapter,
    type DatabaseResolver,
    type TenantShardingDirectory,
} from "@moxt-ai/mobius-relay-cloudflare";

export class PlatformDatabaseResolver implements DatabaseResolver {
    readonly #database: D1DatabaseAdapter;

    constructor(database: D1Database) {
        this.#database = D1DatabaseAdapter.from(database);
    }

    readonly resolve: DatabaseResolver["resolve"] = () => this.#database;
}

export class PlatformTenantShardingDirectory implements TenantShardingDirectory {
    readonly resolve: TenantShardingDirectory["resolve"] = async (tenantId, signal) => {
        signal.throwIfAborted();
        return { tenantId, tenantSharding: { hasShard: false } };
    };

    readonly resolveProject: TenantShardingDirectory["resolveProject"] = async (locator, signal) =>
        await this.resolve(locator.resolveHostingPlacement(), signal);
}
