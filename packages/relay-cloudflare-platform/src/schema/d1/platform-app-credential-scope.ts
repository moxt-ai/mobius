import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The Projects an AppCredential without all-Project access may use. The credential's own record owns this scope. */
export const platformAppCredentialScope = sqliteTable(
    "platform_app_credential_scopes",
    {
        credentialId: text("credential_id").notNull(),
        projectId: text("project_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.credentialId, table.projectId] })],
);
