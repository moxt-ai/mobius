import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordingForkOrigin = sqliteTable(
    "recording_fork_origin",
    {
        createdAt: integer("created_at").notNull(),
        singleton: integer("singleton").primaryKey(),
        sourceRecordingEpoch: text("source_recording_epoch").notNull(),
        sourceSessionId: text("source_session_id").notNull(),
        throughCommandId: text("through_command_id").notNull(),
    },
    (table) => [check("recording_fork_origin_singleton_check", sql`${table.singleton} = 1`)],
);
