import type { ProjectStorageDirectory } from "@moxt-ai/mobius-relay-core/contracts";
import { PairingDirectoryError } from "@moxt-ai/mobius-relay-core/contracts";
import type { PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";

export class PlatformProjectStorageDirectory implements ProjectStorageDirectory {
    readonly #registry: PlatformProjectPlacementRegistry;

    constructor(registry: PlatformProjectPlacementRegistry) {
        this.#registry = registry;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        signal.throwIfAborted();
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null || !this.#registry.supports(placement)) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        return {
            projectId,
            storagePlacement: { hasShard: true, shard: { ...placement, revision: 1 } },
        };
    };
}
