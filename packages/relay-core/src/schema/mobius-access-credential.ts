import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mobiusAccessCredential = sqliteTable(
    "mobius_access_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        publicCredentialId: text("public_credential_id").notNull().unique(),
        grantId: text("grant_id").notNull(),
        tenantId: text("tenant_id").notNull(),
        projectId: text("project_id").notNull(),
        secretDigest: text("secret_digest").notNull().unique(),
        permissionsJson: text("permissions_json").notNull(),
        issuedAt: integer("issued_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        index("mobius_access_credentials_active").on(table.publicCredentialId, table.revokedAt, table.expiresAt),
        index("mobius_access_credentials_project").on(
            table.tenantId,
            table.projectId,
            table.revokedAt,
            table.expiresAt,
        ),
    ],
);
