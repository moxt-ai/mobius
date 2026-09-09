import {
    type ArtifactCountRecord,
    ArtifactCountRecordSchema,
    type UploadedArtifactIdentity,
    UploadedArtifactIdentitySchema,
    type UploadedArtifactRow,
    UploadedArtifactRowSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
export class SessionArtifactStorage {
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }
    readonly countArtifacts = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly ArtifactCountRecord[] =>
        decodeStorageRows(
            ArtifactCountRecordSchema,
            this.#database.query(
                `SELECT COUNT(*) AS artifact_count FROM uploaded_artifacts
       WHERE scope_key = ? AND session_id = ?`,
                [input.scopeKey, input.sessionId],
            ),
        );
    readonly insertUpload = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly fileName: string;
        readonly mediaType: string;
        readonly byteLength: number;
        readonly sha256: string;
        readonly contentTargetId: string;
        readonly uploadTokenHash: string;
        readonly uploadExpiresAt: number;
        readonly createdAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO uploaded_artifacts (
         scope_key, session_id, artifact_id, file_name, media_type, state,
         byte_length, sha256, content_target_id, upload_token_hash,
         upload_expires_at, created_at, available_at
       ) VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, NULL)`,
            [
                input.scopeKey,
                input.sessionId,
                input.artifactId,
                input.fileName,
                input.mediaType,
                input.byteLength,
                input.sha256,
                input.contentTargetId,
                input.uploadTokenHash,
                input.uploadExpiresAt,
                input.createdAt,
            ],
        );
    readonly expireUpload = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE uploaded_artifacts SET state = 'expired'
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?
           AND state = 'uploading'`,
            [input.scopeKey, input.sessionId, input.artifactId],
        );
    readonly completeUpload = (input: {
        readonly availableAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly uploadExpiresAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE uploaded_artifacts
         SET state = 'available', available_at = ?, upload_token_hash = ''
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?
           AND state = 'uploading' AND upload_expires_at > ?`,
            [input.availableAt, input.scopeKey, input.sessionId, input.artifactId, input.uploadExpiresAt],
        );
    readonly listAvailableArtifactIds = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly UploadedArtifactIdentity[] =>
        decodeStorageRows(
            UploadedArtifactIdentitySchema,
            this.#database.query(
                `SELECT artifact_id FROM uploaded_artifacts
       WHERE scope_key = ? AND session_id = ? AND state = 'available'
       ORDER BY created_at, artifact_id`,
                [input.scopeKey, input.sessionId],
            ),
        );
    readonly insertAvailableArtifact = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
        readonly fileName: string;
        readonly mediaType: string;
        readonly byteLength: number;
        readonly sha256: string;
        readonly contentTargetId: string;
        readonly uploadExpiresAt: number;
        readonly createdAt: number;
        readonly availableAt: number | null;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO uploaded_artifacts (
           scope_key, session_id, artifact_id, file_name, media_type, state,
           byte_length, sha256, content_target_id, upload_token_hash,
           upload_expires_at, created_at, available_at
         ) VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, '', ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.artifactId,
                input.fileName,
                input.mediaType,
                input.byteLength,
                input.sha256,
                input.contentTargetId,
                input.uploadExpiresAt,
                input.createdAt,
                input.availableAt,
            ],
        );
    readonly findArtifact = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly artifactId: string;
    }): UploadedArtifactRow | undefined =>
        decodeStorageRows(
            UploadedArtifactRowSchema,
            this.#database.query(
                `SELECT session_id, artifact_id, file_name, media_type, state,
              byte_length, sha256, content_target_id, upload_token_hash,
              upload_expires_at, created_at,
              CAST(available_at AS TEXT) AS available_at
       FROM uploaded_artifacts
       WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
                [input.scopeKey, input.sessionId, input.artifactId],
            ),
        )[0];
}
