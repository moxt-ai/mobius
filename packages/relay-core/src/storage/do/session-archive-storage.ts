import type { StoredArchiveChunk } from "../../entity/do/archive-chunk.ts";
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
    HotActivityDetailRecordSchema,
    type PendingArchivePayload,
    PendingArchivePayloadSchema,
    type UploadedContentTarget,
    UploadedContentTargetSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import { splitUtf8Text, utf8ByteLength } from "./session-text-chunks.ts";
import { rowString } from "./sqlite-row.ts";

export class SessionArchiveStorage {
    readonly retainHotArtifact = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly ownerId: string;
        readonly mediaType: string;
        readonly hotPayload: string;
    }): void => {
        this.insertUploadingArtifact({ ...input, byteLength: utf8ByteLength(input.hotPayload) });
        this.replaceHotArtifactContent(input);
    };

    readonly discardUnreferencedHotArtifacts = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): void => {
        this.#database.run(
            `DELETE FROM artifacts
              WHERE scope_key = ? AND session_id = ? AND state = 'uploading'
                AND NOT EXISTS (
                    SELECT 1 FROM tool_call_views
                     WHERE tool_call_views.scope_key = artifacts.scope_key
                       AND tool_call_views.session_id = artifacts.session_id
                       AND tool_call_views.detail_artifact_id = artifacts.artifact_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM archive_work
                     WHERE archive_work.scope_key = artifacts.scope_key
                       AND archive_work.session_id = artifacts.session_id
                       AND archive_work.target_id = artifacts.artifact_id
                )`,
            [input.scopeKey, input.sessionId],
        );
        this.#database.run(
            `DELETE FROM session_content_chunks
              WHERE scope_key = ? AND session_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM artifacts
                     WHERE artifacts.scope_key = session_content_chunks.scope_key
                       AND artifacts.session_id = session_content_chunks.session_id
                       AND artifacts.artifact_id = session_content_chunks.content_id
                )`,
            [input.scopeKey, input.sessionId],
        );
    };

    readonly stageArtifact = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly ownerId: string;
        readonly mediaType: string;
    }): void => {
        this.enqueueArchiveJob({
            ...input,
            archiveKind: "activity",
            hotPayload: "",
            targetId: input.artifactId,
        });
    };

    readonly discardEventsThrough = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly throughSequence: number;
    }): void => {
        if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
            throw new DatabaseError("database_statement_invalid", "The discarded event sequence is invalid");
        }
        this.persistLatestEventReceipts(input);
        this.#database.run(
            `DELETE FROM session_stream_event_refs
              WHERE scope_key = ? AND session_id = ? AND sequence_number <= ?`,
            [input.scopeKey, input.sessionId, input.throughSequence],
        );
        this.#database.run(
            `DELETE FROM session_stream_blocks
              WHERE scope_key = ? AND session_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM session_stream_event_refs reference
                     WHERE reference.scope_key = session_stream_blocks.scope_key
                       AND reference.session_id = session_stream_blocks.session_id
                       AND reference.stream_id = session_stream_blocks.stream_id
                       AND reference.block_index = session_stream_blocks.block_index
                )`,
            [input.scopeKey, input.sessionId],
        );
        this.#database.run(
            `DELETE FROM session_streams
              WHERE scope_key = ? AND session_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM session_stream_blocks block
                     WHERE block.scope_key = session_streams.scope_key
                       AND block.session_id = session_streams.session_id
                       AND block.stream_id = session_streams.stream_id
                )`,
            [input.scopeKey, input.sessionId],
        );
        this.#database.run(
            `DELETE FROM session_events
              WHERE scope_key = ? AND session_id = ? AND sequence_number <= ?`,
            [input.scopeKey, input.sessionId, input.throughSequence],
        );
        this.#database.run(
            `UPDATE sessions
                SET minimum_sequence = CASE
                    WHEN minimum_sequence > ? THEN minimum_sequence
                    ELSE ?
                END
              WHERE scope_key = ? AND session_id = ?`,
            [input.throughSequence + 1, input.throughSequence + 1, input.scopeKey, input.sessionId],
        );
    };

    readonly discardImportedEventHistory = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly throughSequence: number;
    }): void => {
        const row = this.#database.query(
            `SELECT MIN(e.sequence_number) AS first_active_sequence
               FROM session_events e
               INNER JOIN attempts a
                 ON a.scope_key = e.scope_key
                AND a.session_id = e.session_id
                AND a.attempt_id = e.source_id
               INNER JOIN turns t
                 ON t.scope_key = a.scope_key
                AND t.session_id = a.session_id
                AND t.turn_id = a.turn_id
              WHERE e.scope_key = ? AND e.session_id = ?
                AND e.source_kind = 'attempt'
                AND t.state IN ('running', 'indeterminate')`,
            [input.scopeKey, input.sessionId],
        )[0];
        const firstActiveSequence = row?.["first_active_sequence"];
        if (firstActiveSequence === null || firstActiveSequence === undefined) {
            this.discardEventsThrough(input);
            return;
        }
        if (typeof firstActiveSequence !== "number" || !Number.isSafeInteger(firstActiveSequence)) {
            throw new DatabaseError("database_statement_invalid", "The imported active Turn is invalid");
        }
        if (firstActiveSequence === 0) {
            return;
        }
        this.discardEventsThrough({
            scopeKey: input.scopeKey,
            sessionId: input.sessionId,
            throughSequence: firstActiveSequence - 1,
        });
    };

    readonly stageTurnActivityDetails = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): void => {
        const details = decodeStorageRows(
            HotActivityDetailRecordSchema,
            this.#database.query(
                `SELECT activity_id, detail_artifact_id, '' AS hot_detail
                   FROM tool_call_views
                  INNER JOIN artifacts
                    ON artifacts.scope_key = tool_call_views.scope_key
                   AND artifacts.session_id = tool_call_views.session_id
                   AND artifacts.artifact_id = tool_call_views.detail_artifact_id
                  WHERE tool_call_views.scope_key = ? AND tool_call_views.session_id = ?
                    AND tool_call_views.command_id = ?
                    AND tool_call_views.detail_kind = 'available'
                    AND tool_call_views.detail_artifact_id IS NOT NULL
                    AND artifacts.state = 'uploading'
                  ORDER BY event_sequence`,
                [input.scopeKey, input.sessionId, input.commandId],
            ),
        );
        for (const detail of details) {
            this.stageArtifact({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                artifactId: detail.detail_artifact_id,
                ownerId: detail.activity_id,
                mediaType: "application/json",
            });
        }
    };

    readonly completeArchive = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly targetId: string;
        readonly byteLength: number;
        readonly sha256: string;
        readonly chunks: readonly StoredArchiveChunk[];
    }): void => {
        this.#database.transaction(() => {
            if (this.findArchiveJob(input.scopeKey, input.sessionId, input.targetId) === undefined) {
                return;
            }
            this.publishArtifact({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                artifactId: input.targetId,
                byteLength: input.byteLength,
                sha256: input.sha256,
                chunksJson: JSON.stringify(input.chunks),
            });
            this.clearArchivedActivityDetails({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                detailArtifactId: input.targetId,
            });
            this.deleteHotArtifactContent({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                artifactId: input.targetId,
            });
            this.deleteArchiveJob(input.scopeKey, input.sessionId, input.targetId);
        });
    };

    readonly listArchiveJobs = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly limit: number;
    }): readonly ArchiveJobPayload[] => {
        const jobs = decodeStorageRows(
            ArchiveJobPayloadSchema,
            this.#database.query(
                `SELECT target_id, archive_kind, owner_id, media_type, hot_payload
                   FROM archive_work
                  WHERE scope_key = ? AND session_id = ? AND archive_kind = 'activity'
                  ORDER BY rowid
                  LIMIT ?`,
                [input.scopeKey, input.sessionId, input.limit],
            ),
        );
        return jobs.map((job) => ({
            ...job,
            hot_payload: this.readHotArtifactPayload(
                input.scopeKey,
                input.sessionId,
                rowString(job, "target_id"),
                rowString(job, "hot_payload"),
            ),
        }));
    };

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
                  WHERE scope_key = ? AND session_id = ? AND archive_kind = 'activity'
                  LIMIT 1`,
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
                `SELECT
                    (SELECT COUNT(*)
                       FROM archive_work
                      WHERE scope_key = ? AND session_id = ? AND archive_kind = 'activity') AS pending_jobs,
                    (SELECT COALESCE(SUM(byte_length), 0)
                       FROM artifacts
                      WHERE scope_key = ? AND session_id = ? AND state = 'uploading') +
                    (SELECT COALESCE(SUM(length(CAST(hot_payload AS BLOB))), 0)
                       FROM archive_work work
                      WHERE work.scope_key = ? AND work.session_id = ?
                        AND work.archive_kind = 'activity'
                        AND work.hot_payload <> ''
                        AND NOT EXISTS (
                            SELECT 1 FROM artifacts artifact
                             WHERE artifact.scope_key = work.scope_key
                               AND artifact.session_id = work.session_id
                               AND artifact.artifact_id = work.target_id
                               AND artifact.state = 'uploading'
                        )) AS pending_bytes`,
                [input.scopeKey, input.sessionId, input.scopeKey, input.sessionId, input.scopeKey, input.sessionId],
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
             ON CONFLICT(scope_key, session_id, artifact_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               media_type = excluded.media_type,
               byte_length = excluded.byte_length,
               sha256 = '',
               chunks_json = NULL
             WHERE artifacts.state = 'uploading'`,
            [input.scopeKey, input.sessionId, input.artifactId, input.ownerId, input.mediaType, input.byteLength],
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
                  WHERE scope_key = ? AND session_id = ? AND target_id = ? AND archive_kind = 'activity'`,
                [scopeKey, sessionId, targetId],
            ),
        )[0];

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

    readonly hasHotArtifact = (scopeKey: string, sessionId: string, artifactId: string): boolean =>
        this.#database.query(
            `SELECT 1 FROM artifacts
              WHERE scope_key = ? AND session_id = ? AND artifact_id = ? AND state = 'uploading'
              LIMIT 1`,
            [scopeKey, sessionId, artifactId],
        ).length === 1;

    readonly findArchivePayload = (
        scopeKey: string,
        sessionId: string,
        targetId: string,
    ): ArchivePayload | undefined => {
        const row = decodeStorageRows(
            ArchivePayloadSchema,
            this.#database.query(
                `SELECT hot_payload FROM archive_work
                  WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
                [scopeKey, sessionId, targetId],
            ),
        )[0];
        if (row === undefined) {
            const chunk = this.#database.query(
                `SELECT 1 FROM session_content_chunks
                  WHERE scope_key = ? AND session_id = ? AND content_id = ?
                  LIMIT 1`,
                [scopeKey, sessionId, targetId],
            )[0];
            if (chunk === undefined) {
                return undefined;
            }
            return { hot_payload: this.readHotArtifactPayload(scopeKey, sessionId, targetId, "") };
        }
        return {
            hot_payload: this.readHotArtifactPayload(scopeKey, sessionId, targetId, rowString(row, "hot_payload")),
        };
    };

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
                `SELECT target_id, archive_kind, owner_id, media_type, hot_payload FROM archive_work
                  WHERE scope_key = ? AND session_id = ?`,
                [input.scopeKey, input.sessionId],
            ),
        ).map((job) => ({
            ...job,
            hot_payload: this.readHotArtifactPayload(
                input.scopeKey,
                input.sessionId,
                rowString(job, "target_id"),
                rowString(job, "hot_payload"),
            ),
        }));

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

    readonly #database: DoSqlDatabase;

    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }

    private readonly persistLatestEventReceipts = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly throughSequence: number;
    }): void => {
        this.#database.run(
            `INSERT INTO session_event_receipts (
               scope_key, session_id, source_kind, source_id, event_id,
               payload_hash, source_seq, sequence_number, recorded_at
             )
             SELECT e.scope_key, e.session_id, e.source_kind, e.source_id, e.event_id,
                    e.payload_hash, e.source_seq, e.sequence_number, e.recorded_at
               FROM session_events e
              WHERE e.scope_key = ? AND e.session_id = ? AND e.sequence_number <= ?
                AND NOT EXISTS (
                    SELECT 1 FROM session_events later
                     WHERE later.scope_key = e.scope_key
                       AND later.session_id = e.session_id
                       AND later.source_kind = e.source_kind
                       AND later.source_id = e.source_id
                       AND later.sequence_number <= ?
                       AND (
                           length(later.source_seq) > length(e.source_seq)
                           OR (length(later.source_seq) = length(e.source_seq) AND later.source_seq > e.source_seq)
                       )
                )
             ON CONFLICT(scope_key, session_id, source_kind, source_id) DO UPDATE SET
               event_id = excluded.event_id,
               payload_hash = excluded.payload_hash,
               source_seq = excluded.source_seq,
               sequence_number = excluded.sequence_number,
               recorded_at = excluded.recorded_at
             WHERE length(excluded.source_seq) > length(session_event_receipts.source_seq)
                OR (
                    length(excluded.source_seq) = length(session_event_receipts.source_seq)
                    AND excluded.source_seq > session_event_receipts.source_seq
                )`,
            [input.scopeKey, input.sessionId, input.throughSequence, input.throughSequence],
        );
    };

    private readonly publishArtifact = (input: {
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

    private readonly clearArchivedActivityDetails = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly detailArtifactId: string | null;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE tool_call_views SET hot_detail = NULL
              WHERE scope_key = ? AND session_id = ? AND detail_artifact_id = ?`,
            [input.scopeKey, input.sessionId, input.detailArtifactId],
        );

    private readonly replaceHotArtifactContent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly hotPayload: string;
    }): void => {
        this.deleteHotArtifactContent(input);
        const chunks = splitUtf8Text(input.hotPayload);
        for (const [index, payload] of chunks.entries()) {
            this.#database.run(
                `INSERT INTO session_content_chunks (
                   scope_key, session_id, content_id, chunk_index, payload, byte_length
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [input.scopeKey, input.sessionId, input.artifactId, index, payload, utf8ByteLength(payload)],
            );
        }
    };

    private readonly readHotArtifactPayload = (
        scopeKey: string,
        sessionId: string,
        artifactId: string,
        legacyPayload: string,
    ): string => {
        if (legacyPayload.length > 0) {
            return legacyPayload;
        }
        const chunks = this.#database.query(
            `SELECT chunk_index, payload
               FROM session_content_chunks
              WHERE scope_key = ? AND session_id = ? AND content_id = ?
              ORDER BY chunk_index`,
            [scopeKey, sessionId, artifactId],
        );
        if (chunks.length === 0) {
            throw new DatabaseError("database_statement_invalid", "The hot activity content is unavailable");
        }
        let payload = "";
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (chunk === undefined || chunk["chunk_index"] !== index || typeof chunk["payload"] !== "string") {
                throw new DatabaseError("database_statement_invalid", "The hot activity content is invalid");
            }
            payload += chunk["payload"];
        }
        return payload;
    };

    private readonly deleteHotArtifactContent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `DELETE FROM session_content_chunks
              WHERE scope_key = ? AND session_id = ? AND content_id = ?`,
            [input.scopeKey, input.sessionId, input.artifactId],
        );
}
