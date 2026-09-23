import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const sessionStreams = sqliteTable(
    "session_streams",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        streamId: text("stream_id").notNull(),
        commandId: text("command_id").notNull(),
        messageId: text("message_id").notNull(),
        state: text("state", { enum: ["streaming"] }).notNull(),
        firstSequence: integer("first_sequence").notNull(),
        lastSequence: integer("last_sequence").notNull(),
        nextBlockIndex: integer("next_block_index").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check("session_streams_state_check", sql`state IN ('streaming')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.streamId] }),
        unique("session_streams_scope_key_session_id_command_id_unique").on(
            table.scopeKey,
            table.sessionId,
            table.commandId,
        ),
    ],
);
