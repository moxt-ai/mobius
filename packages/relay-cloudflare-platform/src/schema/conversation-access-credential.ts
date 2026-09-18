import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversationAccessCredential = sqliteTable(
    "conversation_access_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        publicCredentialId: text("public_credential_id").notNull().unique(),
        parentCredentialId: text("parent_credential_id").notNull(),
        parentCredentialRevision: integer("parent_credential_revision").notNull(),
        appId: text("app_id").notNull(),
        projectId: text("project_id").notNull(),
        conversationId: text("conversation_id").notNull(),
        sessionId: text("session_id").notNull(),
        actorRef: text("actor_ref").notNull(),
        permissionsJson: text("permissions_json").notNull(),
        secretDigest: text("secret_digest").notNull(),
        issuedAt: integer("issued_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        index("conversation_access_credentials_lookup").on(table.publicCredentialId, table.revokedAt, table.expiresAt),
        index("conversation_access_credentials_session").on(
            table.projectId,
            table.sessionId,
            table.revokedAt,
            table.expiresAt,
        ),
    ],
);
