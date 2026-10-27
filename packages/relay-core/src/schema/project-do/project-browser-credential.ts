import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectBrowserCredential = sqliteTable(
    "project_browser_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        projectId: text("project_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        createdByCredentialId: text("created_by_credential_id").notNull(),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        index("project_browser_credentials_project").on(
            table.projectId,
            table.revokedAt,
            table.expiresAt,
            table.createdAt,
        ),
    ],
);
