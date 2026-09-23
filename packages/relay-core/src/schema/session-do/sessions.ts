import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
    "sessions",
    {
        scope_key: text("scope_key").notNull(),
        project_id: text("project_id").notNull(),
        session_id: text("session_id").notNull(),
        created_by: text("created_by").notNull(),
        runtime_id: text("runtime_id").notNull(),
        agent_id: text("agent_id").notNull(),
        binding_id: text("binding_id").notNull(),
        directory_id: text("directory_id").notNull(),
        config_revision: integer("config_revision").notNull(),
        binding_created_at: integer("binding_created_at").notNull(),
        title: text("title").notNull(),
        recording_level: text("recording_level", { enum: ["full", "summary"] }).notNull(),
        retention_milliseconds: integer("retention_milliseconds").notNull(),
        idempotency_retention_milliseconds: integer("idempotency_retention_milliseconds").notNull(),
        hot_event_limit: integer("hot_event_limit").notNull(),
        content_limit_bytes: integer("content_limit_bytes").notNull(),
        lifecycle: text("lifecycle", { enum: ["ready", "deleting", "deleted"] }).notNull(),
        delete_requested_at: integer("delete_requested_at").notNull().default(0),
        delete_completed_at: integer("delete_completed_at").notNull().default(0),
        created_at: integer("created_at").notNull(),
        updated_at: integer("updated_at").notNull(),
        next_sequence: integer("next_sequence").notNull().default(1),
        minimum_sequence: integer("minimum_sequence").notNull().default(1),
    },
    (table) => [
        check("sessions_recording_level_check", sql`recording_level IN ('full', 'summary')`),
        check("sessions_lifecycle_check", sql`lifecycle IN ('ready', 'deleting', 'deleted')`),
        primaryKey({ columns: [table.scope_key, table.session_id] }),
        index("sessions_directory").on(table.scope_key, table.updated_at, table.session_id),
    ],
);
