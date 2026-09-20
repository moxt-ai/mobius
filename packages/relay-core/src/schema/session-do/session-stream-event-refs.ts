import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionStreamEventRefs = sqliteTable(
    "session_stream_event_refs",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        sequenceNumber: integer("sequence_number").notNull(),
        streamId: text("stream_id").notNull(),
        blockIndex: integer("block_index").notNull(),
        eventIndex: integer("event_index").notNull(),
    },
    (table) => [
        check("session_stream_event_refs_block_index_check", sql`block_index >= 0`),
        check("session_stream_event_refs_event_index_check", sql`event_index >= 0`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.sequenceNumber] }),
        index("session_stream_event_refs_stream").on(table.scopeKey, table.sessionId, table.streamId, table.blockIndex),
    ],
);
