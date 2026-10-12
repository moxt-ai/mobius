import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordingSessionIndex = sqliteTable(
    "recording_session_indexes",
    {
        sessionId: text("session_id").primaryKey(),
        projectId: text("project_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        firstDeliveredAt: integer("first_delivered_at").notNull(),
        lastDeliveredAt: integer("last_delivered_at").notNull(),
        recordedEventCount: integer("recorded_event_count").notNull(),
        expectedEventCount: integer("expected_event_count").notNull(),
        missingEventCount: integer("missing_event_count").notNull(),
        retentionMilliseconds: integer("retention_milliseconds"),
        expiresAt: integer("expires_at"),
    },
    (table) => [index("recording_session_indexes_updated").on(table.updatedAt, table.sessionId)],
);
