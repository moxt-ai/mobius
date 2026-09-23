import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const archiveWork = sqliteTable(
    "archive_work",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        targetId: text("target_id").notNull(),
        archiveKind: text("archive_kind", { enum: ["activity", "event"] }).notNull(),
        ownerId: text("owner_id").notNull(),
        mediaType: text("media_type").notNull(),
        hotPayload: text("hot_payload").notNull(),
        attempts: integer("attempts").notNull().default(0),
        lastError: text("last_error").notNull().default(""),
    },
    (table) => [
        check("archive_work_archive_kind_check", sql`archive_kind IN ('activity', 'event')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.targetId] }),
    ],
);
