import { sql } from "drizzle-orm";
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
        issuedAt: integer("issued_at").notNull(),
        overlapEndsAt: integer("overlap_ends_at"),
        replacedByCredentialId: text("replaced_by_credential_id"),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        check("platform_app_credentials_all_projects_check", sql`${table.allProjects} in (0, 1)`),
        index("platform_app_credentials_lookup").on(table.publicCredentialId, table.revokedAt, table.overlapEndsAt),
        // Listing scans this index backwards for issued_at DESC, credential_id DESC.
        index("platform_app_credentials_app").on(table.appId, table.issuedAt, table.credentialId),
    ],
);
