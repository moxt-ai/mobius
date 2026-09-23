import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformAppCredentialProject = sqliteTable(
    "platform_app_credential_projects",
    {
        credentialId: text("credential_id").notNull(),
        projectId: text("project_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.credentialId, table.projectId] }),
        index("platform_app_credential_projects_project").on(table.projectId, table.credentialId),
    ],
);
