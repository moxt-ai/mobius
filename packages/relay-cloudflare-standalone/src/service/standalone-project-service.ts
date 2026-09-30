import { createRandomToken, hashSecret } from "@moxt-ai/mobius-relay-core";
import type { StandaloneProjectStorage } from "../storage/standalone-project-storage.ts";

export interface CreatedStandaloneProject {
    readonly projectId: string;
    readonly token: string;
}

export class StandaloneProjectService {
    readonly #storage: StandaloneProjectStorage;

    constructor(storage: StandaloneProjectStorage) {
        this.#storage = storage;
    }

    readonly create = async (signal: AbortSignal): Promise<CreatedStandaloneProject> => {
        signal.throwIfAborted();
        const projectId = `prj_${createRandomToken(18)}`;
        const token = createRandomToken(32);
        await this.#storage.create(projectId, await hashSecret(token), Date.now(), signal);
        signal.throwIfAborted();
        return { projectId, token };
    };
}
