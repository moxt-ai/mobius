import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const botExecutionDirectory = sqliteTable(
    "bot_execution_directory",
    {
        executionId: text("execution_id").primaryKey(),
        botId: text("bot_id").notNull(),
        conversationId: text("conversation_id").notNull(),
        turnId: text("turn_id").notNull(),
        sessionId: text("session_id").notNull(),
        behaviorRevisionId: text("behavior_revision_id").notNull(),
        bindingId: text("binding_id").notNull(),
        bindingRevision: integer("binding_revision").notNull(),
        runtimeId: text("runtime_id").notNull(),
        capabilityId: text("capability_id").notNull().unique(),
        createdAt: integer("created_at").notNull(),
        deadlineAt: integer("deadline_at").notNull(),
    },
    (table) => [
        unique().on(table.conversationId, table.turnId),
        index("bot_execution_directory_session").on(table.sessionId, desc(table.createdAt)),
    ],
);
