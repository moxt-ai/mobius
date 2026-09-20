import {
    type ContentInspection,
    type ContentPersistence,
    ContentStorageError,
    type ContentTarget,
    type ContentWriteResult,
    type ImmutableContent,
} from "../../infra/content-store.ts";
import type { DoSqlDatabase, DoSqlRow } from "../../infra/do-sql-database.ts";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

interface ContentMetadata {
    readonly byteLength: number;
    readonly contentEncoding: ImmutableContent["contentEncoding"];
    readonly mediaType: string;
    readonly sha256: string;
}

function objectKey(target: ContentTarget): string {
    const fields = [target.projectId, target.sessionId, target.artifactId];
    if (fields.some((field) => !SAFE_IDENTIFIER.test(field))) {
        throw new ContentStorageError("content_not_found", "The content target is invalid");
    }
    return fields.join("/");
}

function metadata(row: DoSqlRow): ContentMetadata {
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
    if (error instanceof ContentStorageError) {
        throw error;
    }
    throw new ContentStorageError("content_storage_unavailable", message, {
        cause: error,
    });
}

export class SqliteContentStore implements ContentPersistence {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly delete = async (target: ContentTarget, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        try {
            this.#database.run("DELETE FROM immutable_content WHERE object_key = ?", [objectKey(target)]);
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
            const row = this.#database.query(
                `SELECT byte_length, content_encoding, media_type, sha256
           FROM immutable_content WHERE object_key = ?`,
                [objectKey(target)],
            )[0];
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
            const row = this.#database.query(
                `SELECT bytes, byte_length, content_encoding, media_type, sha256
           FROM immutable_content WHERE object_key = ?`,
                [objectKey(target)],
            )[0];
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
            signal.throwIfAborted();
            return { bytes, ...values };
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be read", error);
        }
    };

    readonly insert = async (
        target: ContentTarget,
        content: ImmutableContent,
        byteLimit: number | null,
        signal: AbortSignal,
    ): Promise<ContentWriteResult> => {
        signal.throwIfAborted();
        try {
            const key = objectKey(target);
            signal.throwIfAborted();
            const result = this.#database.transaction<ContentWriteResult>(() => {
                const existing = this.#database.query(
                    `SELECT byte_length, content_encoding, media_type, sha256
             FROM immutable_content WHERE object_key = ?`,
                    [key],
                )[0];
                if (existing !== undefined) {
                    const values = metadata(existing);
                    return { kind: "existing", metadata: { ...values, kind: "available" } };
                }
                const usage = this.#database.query(
                    "SELECT COALESCE(SUM(byte_length), 0) AS total_bytes FROM immutable_content",
                )[0];
                const totalBytes = usage?.["total_bytes"];
                if (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
                    throw new ContentStorageError(
                        "content_storage_unavailable",
                        "The Durable Object content usage is invalid",
                    );
                }
                if (byteLimit !== null && totalBytes > byteLimit - content.bytes.byteLength) {
                    return { kind: "quota-exceeded", limitBytes: byteLimit };
                }
                this.#database.run(
                    `INSERT INTO immutable_content (
             object_key, bytes, byte_length, content_encoding, media_type, sha256
           ) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        key,
                        Uint8Array.from(content.bytes).buffer,
                        content.bytes.byteLength,
                        content.contentEncoding,
                        content.mediaType,
                        content.sha256,
                    ],
                );
                return { kind: "inserted" };
            });
            signal.throwIfAborted();
            return result;
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            rethrowStorageError("The Durable Object content could not be written", error);
        }
    };
}
