import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessionEventV2 = sqliteTable(
    "session_event_v2",
    {
        eventId: text("event_id").primaryKey(),
        eventJson: text("event_json").notNull(),
        position: integer("position").notNull(),
        sessionId: text("session_id").notNull(),
    },
    (table) => [
        uniqueIndex("session_event_v2_session_position_unique").on(table.sessionId, table.position),
        index("session_event_v2_session_position_index").on(table.sessionId, table.position),
    ],
);
