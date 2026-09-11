import type { ProjectStorageDirectory } from "@moxt-ai/mobius-relay-cloudflare";

export class StandaloneProjectStorageDirectory implements ProjectStorageDirectory {
    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        signal.throwIfAborted();
        return { projectId, storagePlacement: { hasShard: false } };
    };
}
