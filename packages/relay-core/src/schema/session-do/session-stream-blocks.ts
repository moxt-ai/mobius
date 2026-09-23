import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionStreamBlocks = sqliteTable(
    "session_stream_blocks",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        streamId: text("stream_id").notNull(),
        blockIndex: integer("block_index").notNull(),
        sequenceFrom: integer("sequence_from").notNull(),
        sequenceTo: integer("sequence_to").notNull(),
        payload: text("payload").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check("session_stream_blocks_block_index_check", sql`block_index >= 0`),
        check("session_stream_blocks_byte_length_check", sql`byte_length >= 0`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.streamId, table.blockIndex] }),
        check("session_stream_blocks_table_check_4", sql`sequence_from <= sequence_to`),
    ],
);
