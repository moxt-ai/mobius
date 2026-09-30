import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordingMetadata = sqliteTable(
    "recording_metadata",
    {
        singleton: integer("singleton").primaryKey(),
        projectId: text("project_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        sessionId: text("session_id").notNull(),
        recordingEpoch: text("recording_epoch").notNull(),
        createdAt: integer("created_at").notNull(),
        projectionVersion: integer("projection_version").notNull().default(0),
    },
    (table) => [check("recording_metadata_singleton_check", sql`${table.singleton} = 1`)],
);
