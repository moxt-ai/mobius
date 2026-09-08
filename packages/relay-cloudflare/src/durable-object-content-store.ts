import {
    type ContentInspection,
    ContentQuotaExceededError,
    ContentStorageError,
    type ContentTarget,
    type ImmutableContent,
    type ImmutableContentStore,
} from "@moxt-ai/mobius-relay-core";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

interface ContentMetadata {
    readonly byteLength: number;
    readonly contentEncoding: ImmutableContent["contentEncoding"];
    readonly mediaType: string;
    readonly sha256: string;
}

async function digest(bytes: Uint8Array): Promise<string> {
    const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectKey(target: ContentTarget): string {
    const fields = [target.tenantId, target.projectId, target.sessionId, target.artifactId];
    if (fields.some((field) => !SAFE_IDENTIFIER.test(field))) {
        throw new ContentStorageError("content_not_found", "The content target is invalid");
    }
    return fields.join("/");
}

function metadata(row: Readonly<Record<string, SqlStorageValue>>): ContentMetadata {
    const byteLength = row["byte_length"];
    const contentEncoding = row["content_encoding"];
    const mediaType = row["media_type"];
    const sha256 = row["sha256"];
    if (
        typeof byteLength !== "number" ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        (contentEncoding !== "gzip" && contentEncoding !== "identity") ||
        typeof mediaType !== "string" ||
        mediaType.length === 0 ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256)
    ) {
        throw new ContentStorageError("content_storage_unavailable", "The Durable Object content metadata is invalid");
    }
    return { byteLength, contentEncoding, mediaType, sha256 };
}

function rethrowStorageError(message: string, error: unknown): never {
    if (error instanceof ContentStorageError || error instanceof ContentQuotaExceededError) {
        throw error;
    }
    throw new ContentStorageError("content_storage_unavailable", message, {
        cause: error,
    });
}

export class DurableObjectContentStore implements ImmutableContentStore {
    readonly #archiveByteLimit: number;
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage, archiveByteLimit: number) {
        if (!Number.isSafeInteger(archiveByteLimit) || archiveByteLimit < 1) {
            throw new TypeError("The session archive byte limit is invalid");
        }
        this.#archiveByteLimit = archiveByteLimit;
        this.#storage = storage;
        this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS immutable_content (
        object_key TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        content_encoding TEXT NOT NULL CHECK (content_encoding IN ('gzip', 'identity')),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
      ) STRICT;
    `);
    }

    readonly delete = async (target: ContentTarget, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        try {
            this.#storage.sql.exec("DELETE FROM immutable_content WHERE object_key = ?", objectKey(target));
            signal.throwIfAborted();
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be deleted", error);
        }
    };

    readonly inspect = async (target: ContentTarget, signal: AbortSignal): Promise<ContentInspection> => {
        signal.throwIfAborted();
        try {
            const row = this.#storage.sql
                .exec(
                    `SELECT byte_length, content_encoding, media_type, sha256
           FROM immutable_content WHERE object_key = ?`,
                    objectKey(target),
                )
                .toArray()[0];
            signal.throwIfAborted();
            if (row === undefined) {
                return { kind: "missing" };
            }
            return { ...metadata(row), kind: "available" };
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be inspected", error);
        }
    };

    readonly read = async (target: ContentTarget, signal: AbortSignal): Promise<ImmutableContent> => {
        signal.throwIfAborted();
        try {
            const row = this.#storage.sql
                .exec(
                    `SELECT bytes, byte_length, content_encoding, media_type, sha256
           FROM immutable_content WHERE object_key = ?`,
                    objectKey(target),
                )
                .toArray()[0];
            if (row === undefined) {
                throw new ContentStorageError("content_not_found", "The Durable Object content does not exist");
            }
            const storedBytes = row["bytes"];
            const values = metadata(row);
            if (!(storedBytes instanceof ArrayBuffer) || storedBytes.byteLength !== values.byteLength) {
                throw new ContentStorageError(
                    "content_storage_unavailable",
                    "The Durable Object content bytes are invalid",
                );
            }
            const bytes = new Uint8Array(storedBytes);
            if ((await digest(bytes)) !== values.sha256) {
                throw new ContentStorageError(
                    "content_storage_unavailable",
                    "The Durable Object content failed integrity validation",
                );
            }
            signal.throwIfAborted();
            return { bytes, ...values };
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be read", error);
        }
    };

    readonly write = async (target: ContentTarget, content: ImmutableContent, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        try {
            if ((await digest(content.bytes)) !== content.sha256) {
                throw new ContentStorageError("content_conflict", "The supplied content digest is invalid");
            }
            const key = objectKey(target);
            this.#storage.transactionSync(() => {
                const existing = this.#storage.sql
                    .exec(
                        `SELECT byte_length, content_encoding, media_type, sha256
             FROM immutable_content WHERE object_key = ?`,
                        key,
                    )
                    .toArray()[0];
                if (existing !== undefined) {
                    const values = metadata(existing);
                    if (
                        values.byteLength !== content.bytes.byteLength ||
                        values.contentEncoding !== content.contentEncoding ||
                        values.mediaType !== content.mediaType ||
                        values.sha256 !== content.sha256
                    ) {
                        throw new ContentStorageError(
                            "content_conflict",
                            "Immutable Durable Object content already exists with different bytes",
                        );
                    }
                    return;
                }
                const usage = this.#storage.sql
                    .exec("SELECT COALESCE(SUM(byte_length), 0) AS total_bytes FROM immutable_content")
                    .one();
                const totalBytes = usage["total_bytes"];
                if (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
                    throw new ContentStorageError(
                        "content_storage_unavailable",
                        "The Durable Object content usage is invalid",
                    );
                }
                if (totalBytes > this.#archiveByteLimit - content.bytes.byteLength) {
                    throw new ContentQuotaExceededError(this.#archiveByteLimit);
                }
                this.#storage.sql.exec(
                    `INSERT INTO immutable_content (
             object_key, bytes, byte_length, content_encoding, media_type, sha256
           ) VALUES (?, ?, ?, ?, ?, ?)`,
                    key,
                    Uint8Array.from(content.bytes).buffer,
                    content.bytes.byteLength,
                    content.contentEncoding,
                    content.mediaType,
                    content.sha256,
                );
            });
            signal.throwIfAborted();
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be written", error);
        }
    };
}
