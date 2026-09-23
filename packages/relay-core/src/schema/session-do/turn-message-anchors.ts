import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const turnMessageAnchors = sqliteTable(
    "turn_message_anchors",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandId: text("command_id").notNull(),
        messageId: text("message_id").notNull(),
        eventSequence: integer("event_sequence").notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeKey, table.sessionId, table.commandId] })],
);
