import { PairingDirectoryError, type ProjectDatabaseBindings } from "@moxt-ai/mobius-relay-core/contracts";
import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";
import type { PlatformProjectPlacement, PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";

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

export function projectDatabase(shards: readonly PlatformDatabaseBinding[], projectId: string): D1Database {
    const placement = decodePlatformProjectPlacement(projectId);
    const database = shards.find(({ id }) => id === placement?.d1ShardId)?.database;
    if (database === undefined) {
        throw new DatabaseError("database_unavailable", "Project storage is unavailable");
    }
    return database;
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

    readonly resolveLocationHint = (locationHint: string): PlatformProjectPlacement | null => {
        if (locationHint !== "apac" && locationHint !== "wnam") {
            return null;
        }
        const shard = platformDatabaseBindings(this.#bindings).find(({ id }) => id.startsWith(`${locationHint}-`));
        if (shard === undefined || platformBucket(this.#bindings, locationHint) === undefined) {
            return null;
        }
        return { d1ShardId: shard.id, r2BucketId: locationHint };
    };
}

export class PlatformDatabaseResolver implements ProjectDatabaseBindings {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly resolve: ProjectDatabaseBindings["resolve"] = (sharding) => {
        const database = sharding.hasShard
            ? platformDatabaseBindings(this.#bindings).find(({ id }) => id === sharding.shard.d1ShardId)?.database
            : undefined;
        if (database === undefined) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return database;
    };
}
