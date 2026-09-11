import type { ProjectStorageDirectory } from "@moxt-ai/mobius-relay-core";
import { PairingDirectoryError } from "@moxt-ai/mobius-relay-core";
import type { PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import type { ProjectStoragePlacementRow } from "../entity/platform-records.ts";

export interface PlatformProjectPlacementReader {
    readonly read: (projectId: string, signal: AbortSignal) => Promise<ProjectStoragePlacementRow | null>;
}

export class PlatformProjectStorageDirectory implements ProjectStorageDirectory {
    readonly #placements: PlatformProjectPlacementReader;
    readonly #registry: PlatformProjectPlacementRegistry;

    constructor(placements: PlatformProjectPlacementReader, registry: PlatformProjectPlacementRegistry) {
        this.#placements = placements;
        this.#registry = registry;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        const row = await this.#placements.read(projectId, signal);
        if (row === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        const placement = { d1ShardId: row.d1_shard_id, r2BucketId: row.r2_bucket_id };
        if (!this.#registry.supports(placement)) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        return {
            projectId,
            storagePlacement: { hasShard: true, shard: { ...placement, revision: row.placement_revision } },
        };
    };
}
