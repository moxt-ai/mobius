import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordingSessionSummary = sqliteTable(
    "recording_session_summaries",
    {
        sessionId: text("session_id").primaryKey(),
        projectId: text("project_id"),
        runtimeId: text("runtime_id").notNull(),
        agentId: text("agent_id").notNull(),
        directoryId: text("directory_id").notNull(),
        additionalDirectoryIdsJson: text("additional_directory_ids_json").notNull(),
        title: text("title").notNull(),
        status: text("status", { enum: ["running", "idle", "failed"] })
            .notNull()
            .default("idle"),
        prompted: integer("prompted", { mode: "boolean" }).notNull().default(false),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check("recording_session_summaries_status_check", sql`${table.status} in ('running', 'idle', 'failed')`),
        index("recording_session_summaries_updated").on(table.updatedAt, table.sessionId),
    ],
);
