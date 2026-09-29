import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformAppRecordingPolicy = sqliteTable(
    "platform_app_recording_policies",
    {
        appId: text("app_id").primaryKey(),
        mode: text("mode", { enum: ["enabled", "disabled"] }).notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [check("platform_app_recording_policies_mode_check", sql`${table.mode} in ('enabled', 'disabled')`)],
);
