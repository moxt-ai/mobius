import { desc, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionDirectory = sqliteTable(
    "session_directory",
    {
        projectId: text("project_id").notNull(),
        sessionId: text("session_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        cloudRetention: integer("cloud_retention", { mode: "boolean" }).notNull().default(true),
        lifecycle: text("lifecycle", { enum: ["ready", "deleting", "deleted"] }).notNull(),
        updatedAt: integer("updated_at").notNull(),
        summaryJson: text("summary_json").notNull(),
    },
    (table) => [
        check("session_directory_lifecycle_check", sql`${table.lifecycle} in ('ready', 'deleting', 'deleted')`),
        primaryKey({ columns: [table.projectId, table.sessionId] }),
        index("session_directory_page").on(table.projectId, desc(table.updatedAt), desc(table.sessionId)),
        index("session_directory_runtime").on(table.projectId, table.runtimeId, table.lifecycle),
    ],
);
