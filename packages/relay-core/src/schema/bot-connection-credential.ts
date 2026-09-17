import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botConnectionCredential = sqliteTable(
    "bot_connection_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        connectionId: text("connection_id").notNull(),
        secretDigest: text("secret_digest").notNull().unique(),
        issuedAt: integer("issued_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
        replacedByCredentialId: text("replaced_by_credential_id"),
    },
    (table) => [
        index("bot_connection_credentials_connection").on(table.connectionId, table.revokedAt, table.expiresAt),
    ],
);
