import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const archiveSegments = sqliteTable(
    "archive_segments",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        segmentId: text("segment_id").notNull(),
        firstSequence: integer("first_sequence").notNull(),
        lastSequence: integer("last_sequence").notNull(),
        eventCount: integer("event_count").notNull(),
        mediaType: text("media_type").notNull(),
        state: text("state", { enum: ["pending", "uploaded", "published", "deleting", "deleted"] }).notNull(),
        byteLength: integer("byte_length").notNull(),
        sha256: text("sha256").notNull(),
        chunksJson: text("chunks_json"),
    },
    (table) => [
        check(
            "archive_segments_state_check",
            sql`state IN ('pending', 'uploaded', 'published', 'deleting', 'deleted')`,
        ),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.segmentId] }),
        check("archive_segments_table_check_3", sql`first_sequence <= last_sequence`),
        check("archive_segments_table_check_4", sql`event_count = last_sequence - first_sequence + 1`),
        uniqueIndex("archive_segments_range").on(
            table.scopeKey,
            table.sessionId,
            table.firstSequence,
            table.lastSequence,
        ),
    ],
);
