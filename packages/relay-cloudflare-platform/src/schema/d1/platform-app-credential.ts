import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformAppCredential = sqliteTable(
    "platform_app_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        publicCredentialId: text("public_credential_id").notNull().unique(),
        appId: text("app_id").notNull(),
        secretDigest: text("secret_digest").notNull(),
        permissionsJson: text("permissions_json").notNull(),
        allProjects: integer("all_projects").notNull(),
        // Legacy v1 response value retained for existing clients and Worker rollback; not unique or ordered.
        revision: integer("revision").notNull(),
        issuedAt: integer("issued_at").notNull(),
        // Retained only so a rolling deploy or rollback can share the existing D1 schema with an older Worker.
        lastUsedAt: integer("last_used_at").notNull(),
        lastObservedUsedAt: integer("last_observed_used_at"),
        overlapEndsAt: integer("overlap_ends_at"),
        replacedByCredentialId: text("replaced_by_credential_id"),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        check("platform_app_credentials_all_projects_check", sql`${table.allProjects} in (0, 1)`),
        check("platform_app_credentials_revision_check", sql`${table.revision} > 0`),
        index("platform_app_credentials_lookup").on(table.publicCredentialId, table.revokedAt, table.overlapEndsAt),
        index("platform_app_credentials_app").on(table.appId, desc(table.issuedAt), desc(table.credentialId)),
    ],
);
