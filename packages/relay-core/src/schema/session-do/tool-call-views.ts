import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const toolCallViews = sqliteTable(
    "tool_call_views",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandId: text("command_id").notNull(),
        attemptId: text("attempt_id").notNull(),
        activityId: text("activity_id").notNull(),
        summaryJson: text("summary_json").notNull(),
        detailKind: text("detail_kind", { enum: ["available", "truncated", "unrecorded"] }).notNull(),
        detailArtifactId: text("detail_artifact_id"),
        hotDetail: text("hot_detail"),
        capturedBytes: integer("captured_bytes").notNull().default(0),
        originalBytes: integer("original_bytes").notNull().default(0),
        eventSequence: integer("event_sequence").notNull(),
    },
    (table) => [
        check("tool_call_views_detail_kind_check", sql`detail_kind IN ('available', 'truncated', 'unrecorded')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.attemptId, table.activityId] }),
        index("tool_call_views_command_event").on(
            table.scopeKey,
            table.sessionId,
            table.commandId,
            table.eventSequence,
        ),
        index("tool_call_views_detail_artifact")
            .on(table.scopeKey, table.sessionId, table.detailArtifactId)
            .where(sql`detail_artifact_id IS NOT NULL`),
    ],
);
