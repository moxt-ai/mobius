import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const platformConversationMessage = sqliteTable(
    "platform_conversation_messages",
    {
        messageId: text("message_id").primaryKey(),
        credentialId: text("credential_id").notNull(),
        projectId: text("project_id").notNull(),
        conversationId: text("conversation_id").notNull(),
        sessionId: text("session_id").notNull(),
        actorRef: text("actor_ref").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestDigest: text("request_digest").notNull(),
        content: text("content").notNull(),
        imagesJson: text("images_json").notNull(),
        resourcesJson: text("resources_json").notNull(),
        artifactIdsJson: text("artifact_ids_json").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        unique().on(table.projectId, table.sessionId, table.idempotencyKey),
        index("platform_conversation_messages_page").on(
            table.projectId,
            table.sessionId,
            desc(table.createdAt),
            desc(table.messageId),
        ),
    ],
);
