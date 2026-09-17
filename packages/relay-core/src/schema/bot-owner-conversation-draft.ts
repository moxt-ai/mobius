import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botOwnerConversationDraft = sqliteTable("bot_owner_conversation_drafts", {
    botId: text("bot_id").primaryKey(),
    conversationId: text("conversation_id").notNull().unique(),
    createdAt: integer("created_at").notNull(),
});
