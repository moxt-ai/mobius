import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const platformApp = sqliteTable(
    "platform_apps",
    {
        appId: text("app_id").primaryKey(),
        tenantId: text("tenant_id").notNull(),
        displayName: text("display_name").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "suspended", "deleted"] }).notNull(),
        defaultCredentialId: text("default_credential_id"),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        suspendedAt: integer("suspended_at"),
        deletedAt: integer("deleted_at"),
    },
    (table) => [
        check("platform_apps_lifecycle_check", sql`${table.lifecycle} in ('active', 'suspended', 'deleted')`),
        unique().on(table.tenantId, table.displayName),
        index("platform_apps_tenant").on(table.tenantId, table.lifecycle, table.createdAt, table.appId),
    ],
);
