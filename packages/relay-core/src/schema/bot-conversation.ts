import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const botConversation = sqliteTable(
    "bot_conversations",
    {
        conversationId: text("conversation_id").primaryKey(),
        botId: text("bot_id").notNull(),
        behaviorRevisionId: text("behavior_revision_id").notNull(),
        bindingId: text("binding_id").notNull(),
        bindingRevision: integer("binding_revision").notNull(),
        sessionId: text("session_id").notNull().unique(),
        creatorKind: text("creator_kind", { enum: ["owner", "connection"] }).notNull(),
        creatorPrincipalId: text("creator_principal_id").notNull(),
        creatorKey: text("creator_key").notNull(),
        connectionId: text("connection_id"),
        replyDeliveryTargetId: text("reply_delivery_target_id"),
        clientConversationKey: text("client_conversation_key").notNull(),
        title: text("title").notNull(),
        lifecycle: text("lifecycle", { enum: ["provisioning", "active", "closed"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        activatedAt: integer("activated_at"),
        closedAt: integer("closed_at"),
        failureCode: text("failure_code"),
        clientReference: text("client_reference").notNull().default(""),
    },
    (table) => [
        check("bot_conversations_binding_revision_check", sql`${table.bindingRevision} > 0`),
        check("bot_conversations_creator_kind_check", sql`${table.creatorKind} in ('owner', 'connection')`),
        check("bot_conversations_lifecycle_check", sql`${table.lifecycle} in ('provisioning', 'active', 'closed')`),
        unique().on(table.botId, table.creatorKey, table.clientConversationKey),
        index("bot_conversations_bot").on(table.botId, desc(table.createdAt), desc(table.conversationId)),
        index("bot_conversations_client_reference").on(table.botId, table.creatorKind, table.clientReference),
    ],
);
