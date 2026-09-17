import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionAccessCredential = sqliteTable(
    "session_access_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        secretDigest: text("secret_digest").notNull(),
        projectId: text("project_id").notNull(),
        sessionId: text("session_id").notNull(),
        parentCredentialId: text("parent_credential_id").notNull(),
        parentRevision: integer("parent_revision").notNull(),
        expiresAt: integer("expires_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [index("session_access_parent").on(table.parentCredentialId)],
);
