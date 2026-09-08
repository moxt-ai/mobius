import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
    type ContentInspection,
    ContentStorageError,
    type ContentTarget,
    type ImmutableContent,
    type ImmutableContentStore,
} from "@moxt-ai/mobius-relay-core";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

interface StoredContent {
    readonly bytes: Uint8Array;
    readonly contentEncoding: "gzip" | "identity";
    readonly mediaType: string;
    readonly sha256: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStoredContent(encoded: string): StoredContent {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ContentStorageError("content_storage_unavailable", "The filesystem content record is invalid", {
            cause,
        });
    }
    if (!isRecord(value)) {
        throw new ContentStorageError("content_storage_unavailable", "The filesystem content record is invalid");
    }
    const bytes = value["bytes"];
    const contentEncoding = value["contentEncoding"];
    const mediaType = value["mediaType"];
    const sha256 = value["sha256"];
    if (
        typeof bytes !== "string" ||
        (contentEncoding !== "gzip" && contentEncoding !== "identity") ||
        typeof mediaType !== "string" ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256)
    ) {
        throw new ContentStorageError("content_storage_unavailable", "The filesystem content record is invalid");
    }
    return {
        bytes: Uint8Array.from(Buffer.from(bytes, "base64")),
        contentEncoding,
        mediaType,
        sha256,
    };
}

function encodeStoredContent(content: ImmutableContent): string {
    return JSON.stringify({
        bytes: Buffer.from(content.bytes).toString("base64"),
        contentEncoding: content.contentEncoding,
        mediaType: content.mediaType,
        sha256: content.sha256,
    });
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export class FilesystemContentStore implements ImmutableContentStore {
    readonly #root: string;

    constructor(root: string) {
        this.#root = resolve(root);
    }

    readonly delete = async (target: ContentTarget, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        try {
            await unlink(this.path(target));
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return;
            }
            throw new ContentStorageError(
                "content_storage_unavailable",
                "The filesystem content could not be deleted",
                { cause: error },
            );
        }
        signal.throwIfAborted();
    };

    readonly inspect = async (target: ContentTarget, signal: AbortSignal): Promise<ContentInspection> => {
        signal.throwIfAborted();
        try {
            const stored = decodeStoredContent(await readFile(this.path(target), { encoding: "utf8", signal }));
            if (digest(stored.bytes) !== stored.sha256) {
                throw new ContentStorageError(
                    "content_storage_unavailable",
                    "The filesystem content failed integrity validation",
                );
            }
            return {
                byteLength: stored.bytes.byteLength,
                contentEncoding: stored.contentEncoding,
                kind: "available",
                mediaType: stored.mediaType,
                sha256: stored.sha256,
            };
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return { kind: "missing" };
            }
            if (error instanceof ContentStorageError || signal.aborted) {
                throw error;
            }
            throw new ContentStorageError(
                "content_storage_unavailable",
                "The filesystem content could not be inspected",
                { cause: error },
            );
        }
    };

    readonly read = async (target: ContentTarget, signal: AbortSignal): Promise<ImmutableContent> => {
        signal.throwIfAborted();
        let stored: StoredContent;
        try {
            stored = decodeStoredContent(await readFile(this.path(target), { encoding: "utf8", signal }));
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                throw new ContentStorageError("content_not_found", "The filesystem content does not exist", {
                    cause: error,
                });
            }
            if (error instanceof ContentStorageError || signal.aborted) {
                throw error;
            }
            throw new ContentStorageError("content_storage_unavailable", "The filesystem content could not be read", {
                cause: error,
            });
        }
        if (digest(stored.bytes) !== stored.sha256) {
            throw new ContentStorageError(
                "content_storage_unavailable",
                "The filesystem content failed integrity validation",
            );
        }
        return stored;
    };

    readonly write = async (target: ContentTarget, content: ImmutableContent, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (digest(content.bytes) !== content.sha256) {
            throw new ContentStorageError("content_conflict", "The supplied content digest is invalid");
        }
        const path = this.path(target);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(temporary, encodeStoredContent(content), {
                encoding: "utf8",
                flag: "wx",
                signal,
            });
            try {
                await link(temporary, path);
            } catch (error) {
                if (!isNodeError(error) || error.code !== "EEXIST") {
                    throw error;
                }
                const existing = await this.read(target, signal);
                if (
                    existing.sha256 !== content.sha256 ||
                    existing.mediaType !== content.mediaType ||
                    existing.contentEncoding !== content.contentEncoding
                ) {
                    throw new ContentStorageError(
                        "content_conflict",
                        "Immutable content already exists with different bytes",
                    );
                }
            }
        } catch (error) {
            if (error instanceof ContentStorageError || signal.aborted) {
                throw error;
            }
            throw new ContentStorageError(
                "content_storage_unavailable",
                "The filesystem content could not be written",
                { cause: error },
            );
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    };

    private readonly path = (target: ContentTarget): string => {
        const fields = [target.tenantId, target.projectId, target.sessionId, target.artifactId];
        if (fields.some((field) => !SAFE_IDENTIFIER.test(field))) {
            throw new ContentStorageError("content_not_found", "The content target is invalid");
        }
        const path = resolve(this.#root, ...fields);
        if (!path.startsWith(`${this.#root}${sep}`)) {
            throw new ContentStorageError("content_not_found", "The content target is outside the configured root");
        }
        return `${path}.json`;
    };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
