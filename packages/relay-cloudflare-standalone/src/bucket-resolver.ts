import type { BucketResolver } from "@moxt-ai/mobius-relay-cloudflare";

export class SingleBucketResolver implements BucketResolver {
    readonly #bucket: R2Bucket;

    constructor(bucket: R2Bucket) {
        this.#bucket = bucket;
    }

    readonly resolve: BucketResolver["resolve"] = () => this.#bucket;
}
