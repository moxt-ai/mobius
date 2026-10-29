import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformTenant = sqliteTable(
    "platform_tenants",
    {
        tenantId: text("tenant_id").primaryKey(),
        displayName: text("display_name").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "deleted"] }).notNull(),
        quotasJson: text("quotas_json").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        deletedAt: integer("deleted_at"),
    },
    (table) => [check("platform_tenants_lifecycle_check", sql`${table.lifecycle} in ('active', 'deleted')`)],
);
