import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformSessionRecordingPolicy = sqliteTable(
    "platform_session_recording_policies",
    {
        projectId: text("project_id").notNull(),
        sessionId: text("session_id").notNull(),
        mode: text("mode", { enum: ["enabled", "disabled"] }).notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.projectId, table.sessionId] }),
        check("platform_session_recording_policies_mode_check", sql`${table.mode} in ('enabled', 'disabled')`),
    ],
);
