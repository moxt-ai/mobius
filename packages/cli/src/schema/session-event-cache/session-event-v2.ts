import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionEventV2 = sqliteTable(
    "session_event_v2",
    {
        eventJson: text("event_json").notNull(),
        generationId: text("generation_id").notNull(),
        ordinal: integer("position").notNull(),
        sessionId: text("session_id").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.generationId, table.sessionId, table.ordinal] }),
        index("session_event_v2_generation_session_position_index").on(
            table.generationId,
            table.sessionId,
            table.ordinal,
        ),
    ],
);
