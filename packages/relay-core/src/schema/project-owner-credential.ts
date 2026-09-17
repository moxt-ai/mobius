import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectOwnerCredential = sqliteTable(
    "project_owner_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        projectId: text("project_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        sourceChannelId: text("source_channel_id").notNull(),
        createdAt: integer("created_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
        replacedByCredentialId: text("replaced_by_credential_id"),
        overlapEndsAt: integer("overlap_ends_at"),
    },
    (table) => [index("project_owner_credentials_project").on(table.projectId, table.revokedAt, table.createdAt)],
);
