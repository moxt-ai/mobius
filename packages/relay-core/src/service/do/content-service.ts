import {
    type ContentPersistence,
    ContentQuotaExceededError,
    ContentStorageError,
    type ContentTarget,
    type ImmutableContent,
    type ImmutableContentStore,
} from "../../infra/content-store.ts";

async function digest(bytes: Uint8Array): Promise<string> {
    const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ContentService implements ImmutableContentStore {
    readonly #storage: ContentPersistence;
    readonly #byteLimit: number | null;

    constructor(storage: ContentPersistence, byteLimit: number | null) {
        if (byteLimit !== null && (!Number.isSafeInteger(byteLimit) || byteLimit < 1)) {
            throw new TypeError("The session archive byte limit is invalid");
        }
        this.#storage = storage;
        this.#byteLimit = byteLimit;
    }

    readonly delete: ImmutableContentStore["delete"] = (target, signal) => this.#storage.delete(target, signal);
    readonly inspect: ImmutableContentStore["inspect"] = (target, signal) => this.#storage.inspect(target, signal);

    readonly read = async (target: ContentTarget, signal: AbortSignal): Promise<ImmutableContent> => {
        const content = await this.#storage.read(target, signal);
        const actualDigest = await digest(content.bytes);
        signal.throwIfAborted();
        if (actualDigest !== content.sha256) {
            throw new ContentStorageError("content_storage_unavailable", "The content failed integrity validation");
        }
        return content;
    };

    readonly write = async (target: ContentTarget, content: ImmutableContent, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const actualDigest = await digest(content.bytes);
        signal.throwIfAborted();
        if (actualDigest !== content.sha256) {
            throw new ContentStorageError("content_conflict", "The supplied content digest is invalid");
        }
        const result = await this.#storage.insert(target, content, this.#byteLimit, signal);
        switch (result.kind) {
            case "inserted":
                return;
            case "quota-exceeded":
                throw new ContentQuotaExceededError(result.limitBytes);
            case "existing": {
                const existing = result.metadata;
                if (
                    existing.byteLength !== content.bytes.byteLength ||
                    existing.sha256 !== content.sha256 ||
                    existing.mediaType !== content.mediaType ||
                    existing.contentEncoding !== content.contentEncoding
                ) {
                    throw new ContentStorageError(
                        "content_conflict",
                        "Immutable content already exists with different bytes",
                    );
                }
                return;
            }
        }
    };
}
