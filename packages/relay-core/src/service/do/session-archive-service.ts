import type { StoredArchiveChunk } from "../../entity/do/archive-chunk.ts";
import { type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import type {
    ArchiveJobPayload,
    ArtifactManifestRecord,
    CommittedEventRecord,
    ContentManifestRecord,
    SegmentManifestRecord,
    SessionRecord,
} from "../../entity/do/session-records.ts";
import {
    ContentQuotaExceededError,
    ContentStorageError,
    ContentTarget,
    type ImmutableContentStore,
} from "../../infra/content-store.ts";
import type { SessionArchiveStorage } from "../../storage/do/session-archive-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import {
    ARCHIVE_SEGMENT_BYTE_LIMIT,
    ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT,
    gunzip,
    gzip,
    parseSegments,
    sha256,
} from "./session-archive-codec.ts";
import {
    MAX_ARCHIVE_BATCH_SIZE,
    MAX_PENDING_ARCHIVE_BYTE_LIMIT,
    MIN_PENDING_ARCHIVE_BYTE_LIMIT,
    type PreparedEvent,
    scopeKey,
} from "./session-records.ts";

export class SessionArchiveService {
    readonly #content: ImmutableContentStore;
    readonly #storage: SessionArchiveStorage;

    constructor(cx: {
        readonly gateways: { readonly content: ImmutableContentStore };
        readonly storages: { readonly archive: SessionArchiveStorage };
    }) {
        const { content } = cx.gateways;
        this.#content = content;
        this.#storage = cx.storages.archive;
    }

    readonly runWork = async (scope: ProjectScope, sessionId: string, signal: AbortSignal): Promise<number> => {
        const jobs = this.#storage.listArchiveJobs({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            limit: MAX_ARCHIVE_BATCH_SIZE,
        });
        let completed = 0;
        for (const job of jobs) {
            signal.throwIfAborted();
            try {
                await this.archiveJob(scope, sessionId, job, signal);
                completed += 1;
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                this.#storage.recordArchiveFailure({
                    lastError: error instanceof Error ? error.message.slice(0, 500) : "Archive upload failed",
                    scopeKey: scopeKey(scope),
                    sessionId: sessionId,
                    targetId: rowString(job, "target_id"),
                });
                if (error instanceof ContentQuotaExceededError) {
                    throw new SessionRuntimeError("session_quota_exceeded", "The session archive quota is exhausted", {
                        cause: error,
                    });
                }
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The session archive could not be written",
                    { cause: error },
                );
            }
        }
        signal.throwIfAborted();
        return completed;
    };

    readonly hasPendingWork = (scope: ProjectScope, sessionId: string): boolean =>
        this.#storage.findPendingArchiveJob(scopeKey(scope), sessionId) !== undefined;
    readonly assertArchiveCapacity = (
        key: string,
        sessionId: string,
        session: SessionRecord,
        prepared: PreparedEvent,
    ): void => {
        const backlog = this.#storage.getArchiveBacklog({
            scopeKey: key,
            sessionId: sessionId,
        })[0];
        if (backlog === undefined) {
            throw new SessionRuntimeError("session_storage_unavailable", "The session archive backlog is unavailable");
        }
        const incomingPayloads = [
            prepared.payload,
            ...(prepared.activityDetail === null ? [] : [prepared.activityDetail.payload]),
        ];
        const incomingBytes = incomingPayloads.reduce(
            (total, payload) => total + new TextEncoder().encode(payload).byteLength,
            0,
        );
        const byteLimit = Math.min(
            MAX_PENDING_ARCHIVE_BYTE_LIMIT,
            Math.max(MIN_PENDING_ARCHIVE_BYTE_LIMIT, rowNumber(session, "content_limit_bytes") * 4),
        );
        const jobLimit = Math.max(20, rowNumber(session, "hot_event_limit") * 2);
        if (
            rowNumber(backlog, "pending_jobs") + incomingPayloads.length > jobLimit ||
            rowNumber(backlog, "pending_bytes") + incomingBytes > byteLimit
        ) {
            throw new SessionRuntimeError(
                "session_busy",
                "The session archive backlog is full; event ingestion is paused until archiving recovers",
            );
        }
    };

    private readonly archiveJob = async (
        scope: ProjectScope,
        sessionId: string,
        job: ArchiveJobPayload,
        signal: AbortSignal,
    ): Promise<void> => {
        const targetId = rowString(job, "target_id");
        const payload = rowString(job, "hot_payload");
        const mediaType = rowString(job, "media_type");
        const bytes = new TextEncoder().encode(payload);
        const segments: StoredArchiveChunk[] = [];
        const segmentCount = Math.max(1, Math.ceil(bytes.byteLength / ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT));
        for (let index = 0; index < segmentCount; index += 1) {
            signal.throwIfAborted();
            const start = index * ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT;
            const uncompressed = bytes.slice(
                start,
                Math.min(bytes.byteLength, start + ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT),
            );
            const compressed = await gzip(uncompressed, signal);
            if (compressed.byteLength > ARCHIVE_SEGMENT_BYTE_LIMIT) {
                throw new SessionRuntimeError(
                    "content_too_large",
                    "A compressed archive segment exceeds the configured limit",
                );
            }
            const chunkId = `${targetId}.${index.toString().padStart(6, "0")}`;
            const digest = await sha256(compressed);
            await this.#content.write(
                new ContentTarget(scope.tenantId, scope.projectId, sessionId, chunkId),
                {
                    bytes: compressed,
                    contentEncoding: "gzip",
                    mediaType,
                    sha256: digest,
                },
                signal,
            );
            segments.push({
                artifactId: chunkId,
                byteLength: uncompressed.byteLength,
                sha256: digest,
                storedByteLength: compressed.byteLength,
            });
        }
        const digest = await sha256(bytes);
        signal.throwIfAborted();
        this.#storage.completeArchive({
            scopeKey: scopeKey(scope),
            sessionId,
            targetId,
            kind: rowString(job, "archive_kind") === "event" ? "event" : "artifact",
            byteLength: bytes.byteLength,
            sha256: digest,
            chunks: segments,
        });
    };

    readonly readArtifact = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const row = this.#storage.findArtifactManifest(scopeKey(scope), sessionId, artifactId);
        if (row === undefined) {
            throw new SessionRuntimeError("artifact_not_found", "The archive does not exist");
        }
        return await this.readArchivedPayload(
            scope,
            sessionId,
            artifactId,
            row,
            rowString(row, "state") === "available",
            signal,
        );
    };

    private readonly readArchiveSegment = async (
        scope: ProjectScope,
        sessionId: string,
        segmentId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const row = this.#storage.findSegmentManifest(scopeKey(scope), sessionId, segmentId);
        if (row === undefined) {
            throw new SessionRuntimeError("session_storage_unavailable", "The event archive segment does not exist");
        }
        return await this.readArchivedPayload(
            scope,
            sessionId,
            segmentId,
            row,
            rowString(row, "state") === "published",
            signal,
        );
    };

    private readonly readArchivedPayload = async (
        scope: ProjectScope,
        sessionId: string,
        targetId: string,
        row: ArtifactManifestRecord | SegmentManifestRecord,
        published: boolean,
        signal: AbortSignal,
    ): Promise<string> => {
        const chunksJson = rowNullableString(row, "chunks_json");
        if (chunksJson === null) {
            const pending = this.#storage.findArchivePayload(scopeKey(scope), sessionId, targetId);
            if (pending !== undefined) {
                return rowString(pending, "hot_payload");
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is not committed");
        }
        if (!published) {
            throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is not published");
        }
        const segments = parseSegments(chunksJson);
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (const segment of segments) {
                signal.throwIfAborted();
                const content = await this.#content.read(
                    new ContentTarget(scope.tenantId, scope.projectId, sessionId, segment.artifactId),
                    signal,
                );
                if (
                    content.bytes.byteLength !== segment.storedByteLength ||
                    content.sha256 !== segment.sha256 ||
                    (await sha256(content.bytes)) !== segment.sha256
                ) {
                    throw new SessionRuntimeError(
                        "session_storage_unavailable",
                        "An archive segment failed integrity validation",
                    );
                }
                const chunk = await gunzip(content.bytes, signal);
                if (chunk.byteLength !== segment.byteLength) {
                    throw new SessionRuntimeError(
                        "session_storage_unavailable",
                        "An archive segment has an invalid length",
                    );
                }
                chunks.push(chunk);
                total += chunk.byteLength;
            }
        } catch (error) {
            if (signal.aborted || error instanceof SessionRuntimeError) {
                throw error;
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The archive could not be read", {
                cause: error,
            });
        }
        if (total !== rowNumber(row, "byte_length")) {
            throw new SessionRuntimeError("session_storage_unavailable", "The archive has an invalid length");
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        if ((await sha256(bytes)) !== rowString(row, "sha256")) {
            throw new SessionRuntimeError("session_storage_unavailable", "The archive failed integrity validation");
        }
        return new TextDecoder().decode(bytes);
    };

    readonly readEventPayload = async (
        scope: ProjectScope,
        sessionId: string,
        row: CommittedEventRecord,
        signal: AbortSignal,
    ): Promise<string> => {
        const payload = rowNullableString(row, "payload");
        return (
            payload ?? (await this.readArchiveSegment(scope, sessionId, rowString(row, "archive_segment_id"), signal))
        );
    };

    readonly deleteArchivedContent = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const uploadedArtifacts = this.#storage.listUploadedContentTargets({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        for (const artifact of uploadedArtifacts) {
            signal.throwIfAborted();
            await this.deleteContent(scope, sessionId, rowString(artifact, "content_target_id"), signal);
        }
        const manifests = this.#storage.listContentManifests({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            scopeKey2: scopeKey(scope),
            sessionId2: sessionId,
        });
        for (const manifest of manifests) {
            await this.deleteManifestSegments(scope, sessionId, manifest, signal);
        }
        const pending = this.#storage.listPendingArchivePayloads({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        for (const job of pending) {
            const bytes = new TextEncoder().encode(rowString(job, "hot_payload"));
            const count = Math.max(1, Math.ceil(bytes.byteLength / ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT));
            for (let index = 0; index < count; index += 1) {
                signal.throwIfAborted();
                await this.deleteContent(
                    scope,
                    sessionId,
                    `${rowString(job, "target_id")}.${index.toString().padStart(6, "0")}`,
                    signal,
                );
            }
        }
    };

    private readonly deleteManifestSegments = async (
        scope: ProjectScope,
        sessionId: string,
        manifest: ContentManifestRecord,
        signal: AbortSignal,
    ): Promise<void> => {
        const encoded = rowNullableString(manifest, "chunks_json");
        if (encoded === null) {
            return;
        }
        for (const segment of parseSegments(encoded)) {
            await this.deleteContent(scope, sessionId, segment.artifactId, signal);
        }
    };

    private readonly deleteContent = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            await this.#content.delete(
                new ContentTarget(scope.tenantId, scope.projectId, sessionId, artifactId),
                signal,
            );
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof ContentStorageError && error.code === "content_not_found") {
                return;
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The archived content could not be deleted", {
                cause: error,
            });
        }
    };
}
