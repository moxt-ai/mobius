import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const sessionMessages = sqliteTable(
    "session_messages",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        messageId: text("message_id").notNull(),
        commandId: text("command_id").notNull(),
        role: text("role", { enum: ["user", "assistant"] }).notNull(),
        parentId: text("parent_id"),
        content: text("content").notNull(),
        contentChunks: integer("content_chunks").notNull().default(0),
        tokenEstimate: integer("token_estimate").notNull().default(0),
        createdAt: integer("created_at").notNull(),
        completedAt: integer("completed_at"),
    },
    (table) => [
        check("session_messages_role_check", sql`role IN ('user', 'assistant')`),
        check("session_messages_content_chunks_check", sql`content_chunks >= 0`),
        check("session_messages_token_estimate_check", sql`token_estimate >= 0`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.messageId] }),
        unique("session_messages_scope_key_session_id_command_id_role_unique").on(
            table.scopeKey,
            table.sessionId,
            table.commandId,
            table.role,
        ),
        index("session_messages_page").on(table.scopeKey, table.sessionId, table.createdAt, table.commandId),
    ],
);
