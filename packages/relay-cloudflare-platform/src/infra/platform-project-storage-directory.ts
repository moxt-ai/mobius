import type { ProjectStorageDirectory } from "@moxt-ai/mobius-relay-core/contracts";
import { PairingDirectoryError } from "@moxt-ai/mobius-relay-core/contracts";
import type { PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement, projectBucketLocation } from "../entity/platform-project-id.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

/** The Platform directory is the Project lifecycle authority; it decides whether a Project's storage is served. */
type ActiveProjects = Pick<PlatformControlPlaneStorage, "readActiveProjectScope">;

export class PlatformProjectStorageDirectory implements ProjectStorageDirectory {
    readonly #registry: PlatformProjectPlacementRegistry;
    readonly #projects: ActiveProjects;

    constructor(registry: PlatformProjectPlacementRegistry, projects: ActiveProjects) {
        this.#registry = registry;
        this.#projects = projects;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        signal.throwIfAborted();
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null || !this.#registry.supports(placement)) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        if ((await this.#projects.readActiveProjectScope(projectId, signal)) === null) {
            return null;
        }
        signal.throwIfAborted();
        return {
            projectId,
            storagePlacement: {
                hasShard: true,
                shard: {
                    d1ShardId: projectId,
                    r2BucketId: projectBucketLocation(placement.locationHint),
                    revision: 1,
                },
            },
        };
    };
}
