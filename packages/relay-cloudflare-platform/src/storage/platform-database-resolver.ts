import { D1DatabaseAdapter, type DatabaseResolver } from "@moxt-ai/mobius-relay-cloudflare";
import { PairingDirectoryError } from "@moxt-ai/mobius-relay-core";
import type { PlatformProjectPlacement, PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";

export interface PlatformStorageBindings {
    readonly D1_SHARD_APAC_01?: D1Database;
    readonly D1_SHARD_APAC_02?: D1Database;
    readonly D1_SHARD_WNAM_01?: D1Database;
    readonly D1_SHARD_WNAM_02?: D1Database;
    readonly R2_BUCKET_APAC?: R2Bucket;
    readonly R2_BUCKET_WNAM?: R2Bucket;
}

export interface PlatformDatabaseBinding {
    readonly database: D1Database;
    readonly id: string;
}

export function platformDatabaseBindings(bindings: PlatformStorageBindings): readonly PlatformDatabaseBinding[] {
    const candidates: ReadonlyArray<{ readonly database: D1Database | undefined; readonly id: string }> = [
        { database: bindings.D1_SHARD_APAC_01, id: "apac-01" },
        { database: bindings.D1_SHARD_APAC_02, id: "apac-02" },
        { database: bindings.D1_SHARD_WNAM_01, id: "wnam-01" },
        { database: bindings.D1_SHARD_WNAM_02, id: "wnam-02" },
    ];
    const configured: PlatformDatabaseBinding[] = [];
    for (const candidate of candidates) {
        if (candidate.database !== undefined) {
            configured.push({ database: candidate.database, id: candidate.id });
        }
    }
    return Object.freeze(configured);
}

export function platformBucket(bindings: PlatformStorageBindings, id: string): R2Bucket | undefined {
    return id === "apac" ? bindings.R2_BUCKET_APAC : id === "wnam" ? bindings.R2_BUCKET_WNAM : undefined;
}

export class PlatformStorageRegistry implements PlatformProjectPlacementRegistry {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly supports = (placement: PlatformProjectPlacement): boolean =>
        placement.d1ShardId.startsWith(`${placement.r2BucketId}-`) &&
        platformDatabaseBindings(this.#bindings).some(({ id }) => id === placement.d1ShardId) &&
        platformBucket(this.#bindings, placement.r2BucketId) !== undefined;
}

export class PlatformDatabaseResolver implements DatabaseResolver {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly resolve: DatabaseResolver["resolve"] = (sharding) => {
        const database = sharding.hasShard
            ? platformDatabaseBindings(this.#bindings).find(({ id }) => id === sharding.shard.d1ShardId)?.database
            : undefined;
        if (database === undefined) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return D1DatabaseAdapter.from(database);
    };
}
