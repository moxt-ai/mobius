import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const turnContentViews = sqliteTable(
    "turn_content_views",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandId: text("command_id").notNull(),
        contentId: text("content_id").notNull(),
        contentJson: text("content_json").notNull(),
        eventSequence: integer("event_sequence").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.commandId, table.contentId] }),
        index("turn_content_views_command_event").on(
            table.scopeKey,
            table.sessionId,
            table.commandId,
            table.eventSequence,
        ),
    ],
);
