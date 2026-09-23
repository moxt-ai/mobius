import type { BucketResolver } from "@moxt-ai/mobius-relay-core/contracts";
import { ContentStorageError } from "@moxt-ai/mobius-relay-core/contracts";
import { type PlatformStorageBindings, platformBucket } from "./platform-database-resolver.ts";

export class PlatformBucketResolver implements BucketResolver {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly resolve: BucketResolver["resolve"] = (sharding) => {
        const bucket = sharding.hasShard ? platformBucket(this.#bindings, sharding.shard.r2BucketId) : undefined;
        if (bucket === undefined) {
            throw new ContentStorageError("content_storage_unavailable", "Project content storage is unavailable");
        }
        return bucket;
    };
}
