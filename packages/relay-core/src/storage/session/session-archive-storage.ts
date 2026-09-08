import {
    type ArchiveBacklog,
    ArchiveBacklogSchema,
    type ArchiveJobIdentity,
    ArchiveJobIdentitySchema,
    type ArchiveJobPayload,
    ArchiveJobPayloadSchema,
    type ArchivePayload,
    ArchivePayloadSchema,
    type ArtifactManifestRecord,
    ArtifactManifestRecordSchema,
    type ContentManifestRecord,
    ContentManifestRecordSchema,
    type PendingArchivePayload,
    PendingArchivePayloadSchema,
    type SegmentManifestRecord,
    SegmentManifestRecordSchema,
    type UploadedContentTarget,
    UploadedContentTargetSchema,
} from "../../entity/session/session-records.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";

export class SessionArchiveStorage {
    readonly #database: SessionSqlDatabase;
    constructor(database: SessionSqlDatabase) {
        this.#database = database;
    }

    readonly listArchiveJobs = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly limit: number;
    }): readonly ArchiveJobPayload[] =>
        decodeStorageRows(
            ArchiveJobPayloadSchema,
            this.#database.query(
                `SELECT target_id, archive_kind, owner_id, media_type, hot_payload
       FROM archive_work
       WHERE scope_key = ? AND session_id = ?
       ORDER BY rowid
       LIMIT ?`,
                [input.scopeKey, input.sessionId, input.limit],
            ),
        );

    readonly recordArchiveFailure = (input: {
        readonly lastError: string;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly targetId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE archive_work
           SET attempts = attempts + 1, last_error = ?
           WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
            [input.lastError, input.scopeKey, input.sessionId, input.targetId],
        );

    readonly findPendingArchiveJob = (scopeKey: string, sessionId: string): ArchiveJobIdentity | undefined =>
        decodeStorageRows(
            ArchiveJobIdentitySchema,
            this.#database.query(
                `SELECT target_id FROM archive_work
       WHERE scope_key = ? AND session_id = ? LIMIT 1`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly getArchiveBacklog = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly ArchiveBacklog[] =>
        decodeStorageRows(
            ArchiveBacklogSchema,
            this.#database.query(
                `SELECT COUNT(*) AS pending_jobs,
              COALESCE(SUM(length(CAST(hot_payload AS BLOB))), 0) AS pending_bytes
       FROM archive_work
       WHERE scope_key = ? AND session_id = ?`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly insertUploadingArtifact = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly ownerId: string;
        readonly mediaType: string;
        readonly byteLength: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO artifacts (
         scope_key, session_id, artifact_id, owner_id, media_type, state,
         byte_length, sha256, chunks_json
       ) VALUES (?, ?, ?, ?, ?, 'uploading', ?, '', NULL)
       ON CONFLICT(scope_key, session_id, artifact_id) DO NOTHING`,
            [input.scopeKey, input.sessionId, input.artifactId, input.ownerId, input.mediaType, input.byteLength],
        );

    readonly insertPendingSegment = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly segmentId: string;
        readonly firstSequence: number;
        readonly lastSequence: number;
        readonly mediaType: string;
        readonly byteLength: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO archive_segments (
         scope_key, session_id, segment_id, first_sequence, last_sequence,
         event_count, media_type, state, byte_length, sha256, chunks_json
       ) VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', ?, '', NULL)
       ON CONFLICT(scope_key, session_id, segment_id) DO NOTHING`,
            [
                input.scopeKey,
                input.sessionId,
                input.segmentId,
                input.firstSequence,
                input.lastSequence,
                input.mediaType,
                input.byteLength,
            ],
        );

    readonly enqueueArchiveJob = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly targetId: string;
        readonly archiveKind: string;
        readonly ownerId: string;
        readonly mediaType: string;
        readonly hotPayload: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO archive_work (
         scope_key, session_id, target_id, archive_kind, owner_id,
         media_type, hot_payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, session_id, target_id) DO NOTHING`,
            [
                input.scopeKey,
                input.sessionId,
                input.targetId,
                input.archiveKind,
                input.ownerId,
                input.mediaType,
                input.hotPayload,
            ],
        );

    readonly findArchiveJob = (scopeKey: string, sessionId: string, targetId: string): ArchiveJobIdentity | undefined =>
        decodeStorageRows(
            ArchiveJobIdentitySchema,
            this.#database.query(
                `SELECT target_id FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
                [scopeKey, sessionId, targetId],
            ),
        )[0];

    readonly publishSegment = (input: {
        readonly byteLength: number;
        readonly sha256: string;
        readonly chunksJson: string | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly segmentId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE archive_segments
           SET state = 'published', byte_length = ?, sha256 = ?, chunks_json = ?
           WHERE scope_key = ? AND session_id = ? AND segment_id = ?
             AND state = 'pending'`,
            [input.byteLength, input.sha256, input.chunksJson, input.scopeKey, input.sessionId, input.segmentId],
        );

    readonly publishArtifact = (input: {
        readonly byteLength: number;
        readonly sha256: string;
        readonly chunksJson: string | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE artifacts
           SET state = 'available', byte_length = ?, sha256 = ?, chunks_json = ?
           WHERE scope_key = ? AND session_id = ? AND artifact_id = ?
             AND state = 'uploading'`,
            [input.byteLength, input.sha256, input.chunksJson, input.scopeKey, input.sessionId, input.artifactId],
        );

    readonly deleteArchiveJob = (scopeKey: string, sessionId: string, targetId: string): { readonly changes: number } =>
        this.#database.run(
            `DELETE FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
            [scopeKey, sessionId, targetId],
        );

    readonly clearArchivedEventPayloads = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly archiveSegmentId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE session_events SET payload = NULL
           WHERE scope_key = ? AND session_id = ? AND archive_segment_id = ?`,
            [input.scopeKey, input.sessionId, input.archiveSegmentId],
        );

    readonly clearArchivedActivityDetails = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly detailArtifactId: string | null;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE tool_call_views SET hot_detail = NULL
           WHERE scope_key = ? AND session_id = ? AND detail_artifact_id = ?`,
            [input.scopeKey, input.sessionId, input.detailArtifactId],
        );

    readonly findArtifactManifest = (
        scopeKey: string,
        sessionId: string,
        artifactId: string,
    ): ArtifactManifestRecord | undefined =>
        decodeStorageRows(
            ArtifactManifestRecordSchema,
            this.#database.query(
                `SELECT state, byte_length, sha256, chunks_json FROM artifacts
       WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
                [scopeKey, sessionId, artifactId],
            ),
        )[0];

    readonly findSegmentManifest = (
        scopeKey: string,
        sessionId: string,
        segmentId: string,
    ): SegmentManifestRecord | undefined =>
        decodeStorageRows(
            SegmentManifestRecordSchema,
            this.#database.query(
                `SELECT state, byte_length, sha256, chunks_json FROM archive_segments
       WHERE scope_key = ? AND session_id = ? AND segment_id = ?`,
                [scopeKey, sessionId, segmentId],
            ),
        )[0];

    readonly findArchivePayload = (scopeKey: string, sessionId: string, targetId: string): ArchivePayload | undefined =>
        decodeStorageRows(
            ArchivePayloadSchema,
            this.#database.query(
                `SELECT hot_payload FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
                [scopeKey, sessionId, targetId],
            ),
        )[0];

    readonly listContentManifests = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly scopeKey2: string;
        readonly sessionId2: string;
    }): readonly ContentManifestRecord[] =>
        decodeStorageRows(
            ContentManifestRecordSchema,
            this.#database.query(
                `SELECT chunks_json FROM artifacts
       WHERE scope_key = ? AND session_id = ? AND chunks_json IS NOT NULL
       UNION ALL
       SELECT chunks_json FROM archive_segments
       WHERE scope_key = ? AND session_id = ? AND chunks_json IS NOT NULL`,
                [input.scopeKey, input.sessionId, input.scopeKey2, input.sessionId2],
            ),
        );

    readonly listPendingArchivePayloads = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly PendingArchivePayload[] =>
        decodeStorageRows(
            PendingArchivePayloadSchema,
            this.#database.query(
                `SELECT target_id, hot_payload FROM archive_work
       WHERE scope_key = ? AND session_id = ?`,
                [input.scopeKey, input.sessionId],
            ),
        );
    readonly listUploadedContentTargets = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly UploadedContentTarget[] =>
        decodeStorageRows(
            UploadedContentTargetSchema,
            this.#database.query(
                `SELECT content_target_id FROM uploaded_artifacts
       WHERE scope_key = ? AND session_id = ?`,
                [input.scopeKey, input.sessionId],
            ),
        );
}
