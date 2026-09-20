import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionContentChunks = sqliteTable(
    "session_content_chunks",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        contentId: text("content_id").notNull(),
        chunkIndex: integer("chunk_index").notNull(),
        payload: text("payload").notNull(),
        byteLength: integer("byte_length").notNull(),
    },
    (table) => [
        check("session_content_chunks_chunk_index_check", sql`chunk_index >= 0`),
        check("session_content_chunks_byte_length_check", sql`byte_length >= 0`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.contentId, table.chunkIndex] }),
    ],
);
