import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformProjectRecordingPolicy = sqliteTable(
    "platform_project_recording_policies",
    {
        projectId: text("project_id").primaryKey(),
        mode: text("mode", { enum: ["enabled", "disabled"] }).notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [check("platform_project_recording_policies_mode_check", sql`${table.mode} in ('enabled', 'disabled')`)],
);
