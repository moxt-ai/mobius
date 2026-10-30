import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// No operation deletes a Tenant, so it records no lifecycle.
export const platformTenant = sqliteTable("platform_tenants", {
    tenantId: text("tenant_id").primaryKey(),
    displayName: text("display_name").notNull(),
    quotasJson: text("quotas_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
});
