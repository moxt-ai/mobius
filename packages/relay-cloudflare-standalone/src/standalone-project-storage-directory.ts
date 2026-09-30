import { PairingDirectoryError, type ProjectStorageDirectory, validateIdentifier } from "@moxt-ai/mobius-relay-core";
import type { StandaloneProjectStorage } from "./storage/standalone-project-storage.ts";

export class StandaloneProjectStorageDirectory implements ProjectStorageDirectory {
    readonly #projects: StandaloneProjectStorage;

    constructor(projects: StandaloneProjectStorage) {
        this.#projects = projects;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        if ((await this.#projects.read(normalizedProjectId, signal)) === null) {
            throw new PairingDirectoryError("directory_unavailable", "The Project is unavailable");
        }
        return { projectId: normalizedProjectId, storagePlacement: { hasShard: false } };
    };
}
