import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const uploadedArtifacts = sqliteTable(
    "uploaded_artifacts",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        artifactId: text("artifact_id").notNull(),
        fileName: text("file_name").notNull(),
        mediaType: text("media_type").notNull(),
        state: text("state", { enum: ["uploading", "available", "expired"] }).notNull(),
        byteLength: integer("byte_length").notNull(),
        sha256: text("sha256").notNull(),
        contentTargetId: text("content_target_id").notNull(),
        uploadTokenHash: text("upload_token_hash").notNull(),
        uploadExpiresAt: integer("upload_expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
        availableAt: integer("available_at"),
    },
    (table) => [
        check("uploaded_artifacts_state_check", sql`state IN ('uploading', 'available', 'expired')`),
        check("uploaded_artifacts_byte_length_check", sql`byte_length > 0`),
        check("uploaded_artifacts_sha256_check", sql`length(sha256) = 64`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.artifactId] }),
    ],
);
