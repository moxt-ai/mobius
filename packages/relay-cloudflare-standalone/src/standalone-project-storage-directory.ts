import { PairingDirectoryError, type ProjectStorageDirectory, validateIdentifier } from "@moxt-ai/mobius-relay-core";

export const STANDALONE_PROJECT_ID = "standalone";

export class StandaloneProjectStorageDirectory implements ProjectStorageDirectory {
    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        signal.throwIfAborted();
        if (validateIdentifier(projectId, "project_id") !== STANDALONE_PROJECT_ID) {
            throw new PairingDirectoryError("directory_unavailable", "The Project is unavailable");
        }
        return { projectId, storagePlacement: { hasShard: false } };
    };
}
