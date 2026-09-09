import {
    type ContentInspection,
    type ContentPersistence,
    ContentStorageError,
    type ContentTarget,
    type ContentWriteResult,
    type ImmutableContent,
} from "@moxt-ai/mobius-relay-core";
import type { BucketResolver } from "./bucket-resolver.ts";
import type { TenantShardingDirectory } from "./tenant-sharding-directory.ts";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

async function r2Operation<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    signal: AbortSignal,
): Promise<Value> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
        () =>
            controller.abort(new ContentStorageError("content_storage_timeout", "The R2 content operation timed out")),
        15_000,
    );
    let rejectAbort = (): void => {};
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", rejectAbort, { once: true });
            if (signal.aborted) {
                cancel();
            }
        });
        return await Promise.race([aborted, operation(controller.signal)]);
    } catch (cause) {
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        throw cause;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", rejectAbort);
    }
}

function unavailable(message: string, cause: unknown): ContentStorageError {
    if (cause instanceof ContentStorageError) {
        return cause;
    }
    return new ContentStorageError("content_storage_unavailable", message, {
        cause,
    });
}

function objectKey(target: ContentTarget): string {
    const fields = [target.tenantId, target.projectId, target.sessionId, target.artifactId];
    if (fields.some((field) => !SAFE_IDENTIFIER.test(field))) {
        throw new ContentStorageError("content_not_found", "The content target is invalid");
    }
    return fields.join("/");
}

function metadata(object: R2Object): {
    readonly contentEncoding: "gzip" | "identity";
    readonly mediaType: string;
    readonly sha256: string;
} {
    const contentEncoding = object.customMetadata?.["contentEncoding"];
    const mediaType = object.customMetadata?.["mediaType"];
    const sha256 = object.customMetadata?.["sha256"];
    if (
        (contentEncoding !== "gzip" && contentEncoding !== "identity") ||
        typeof mediaType !== "string" ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256)
    ) {
        throw new ContentStorageError("content_storage_unavailable", "The R2 content metadata is invalid");
    }
    return { contentEncoding, mediaType, sha256 };
}

export class R2ContentStore implements ContentPersistence {
    readonly #buckets: BucketResolver;
    readonly #tenants: TenantShardingDirectory;

    private readonly keyPrefix: string;
    constructor(buckets: BucketResolver, tenants: TenantShardingDirectory, keyPrefix = "") {
        this.#buckets = buckets;
        this.#tenants = tenants;
        this.keyPrefix = keyPrefix;
    }

    readonly delete = async (target: ContentTarget, signal: AbortSignal): Promise<void> => {
        return r2Operation(async (signal) => {
            signal.throwIfAborted();
            try {
                const key = this.keyPrefix + objectKey(target);
                const tenant = await this.#tenants.resolve(target.tenantId, signal);
                signal.throwIfAborted();
                const bucket = this.#buckets.resolve(tenant.tenantSharding);
                await bucket.delete(key);
                signal.throwIfAborted();
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                throw unavailable("The R2 content could not be deleted", error);
            }
        }, signal);
    };

    readonly inspect = async (target: ContentTarget, signal: AbortSignal): Promise<ContentInspection> => {
        return r2Operation(async (signal): Promise<ContentInspection> => {
            signal.throwIfAborted();
            try {
                const key = this.keyPrefix + objectKey(target);
                const tenant = await this.#tenants.resolve(target.tenantId, signal);
                signal.throwIfAborted();
                const bucket = this.#buckets.resolve(tenant.tenantSharding);
                const object = await bucket.head(key);
                signal.throwIfAborted();
                if (object === null) {
                    return { kind: "missing" };
                }
                const values = metadata(object);
                return {
                    byteLength: object.size,
                    contentEncoding: values.contentEncoding,
                    kind: "available",
                    mediaType: values.mediaType,
                    sha256: values.sha256,
                };
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                throw unavailable("The R2 content could not be inspected", error);
            }
        }, signal);
    };

    readonly read = async (target: ContentTarget, signal: AbortSignal): Promise<ImmutableContent> => {
        return r2Operation(async (signal) => {
            signal.throwIfAborted();
            try {
                const key = this.keyPrefix + objectKey(target);
                const tenant = await this.#tenants.resolve(target.tenantId, signal);
                signal.throwIfAborted();
                const bucket = this.#buckets.resolve(tenant.tenantSharding);
                const object = await bucket.get(key);
                if (object === null) {
                    throw new ContentStorageError("content_not_found", "The R2 content does not exist");
                }
                try {
                    signal.throwIfAborted();
                    const values = metadata(object);
                    const chunks: Uint8Array[] = [];
                    let length = 0;
                    await object.body.pipeTo(
                        new WritableStream<Uint8Array>({
                            write: (chunk) => {
                                chunks.push(chunk);
                                length += chunk.byteLength;
                            },
                        }),
                        { signal },
                    );
                    signal.throwIfAborted();
                    const bytes = new Uint8Array(length);
                    let offset = 0;
                    for (const chunk of chunks) {
                        bytes.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    return { bytes, ...values };
                } finally {
                    if (!object.bodyUsed) {
                        await object.body.cancel();
                    }
                }
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                throw unavailable("The R2 content could not be read", error);
            }
        }, signal);
    };

    readonly insert = async (
        target: ContentTarget,
        content: ImmutableContent,
        _byteLimit: number | null,
        signal: AbortSignal,
    ): Promise<ContentWriteResult> => {
        return r2Operation(async (signal): Promise<ContentWriteResult> => {
            signal.throwIfAborted();
            try {
                const key = this.keyPrefix + objectKey(target);
                const tenant = await this.#tenants.resolve(target.tenantId, signal);
                signal.throwIfAborted();
                const bucket = this.#buckets.resolve(tenant.tenantSharding);
                const written = await bucket.put(key, Uint8Array.from(content.bytes).buffer, {
                    customMetadata: {
                        contentEncoding: content.contentEncoding,
                        mediaType: content.mediaType,
                        sha256: content.sha256,
                    },
                    onlyIf: { etagDoesNotMatch: "*" },
                });
                signal.throwIfAborted();
                if (written !== null) {
                    return { kind: "inserted" };
                }
                const existing = await bucket.head(key);
                signal.throwIfAborted();
                if (existing === null) {
                    throw new ContentStorageError(
                        "content_storage_unavailable",
                        "The immutable R2 write was not committed",
                    );
                }
                const values = metadata(existing);
                return { kind: "existing", metadata: { kind: "available", byteLength: existing.size, ...values } };
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                throw unavailable("The R2 content could not be written", error);
            }
        }, signal);
    };
}
