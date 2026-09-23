import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const artifacts = sqliteTable(
    "artifacts",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        artifactId: text("artifact_id").notNull(),
        ownerId: text("owner_id").notNull(),
        mediaType: text("media_type").notNull(),
        state: text("state", {
            enum: ["uploading", "available", "deleting", "deleted", "failed", "expired"],
        }).notNull(),
        byteLength: integer("byte_length").notNull(),
        sha256: text("sha256").notNull(),
        chunksJson: text("chunks_json"),
    },
    (table) => [
        check(
            "artifacts_state_check",
            sql`state IN ('uploading', 'available', 'deleting', 'deleted', 'failed', 'expired')`,
        ),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.artifactId] }),
    ],
);
