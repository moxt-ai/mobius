import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformProjectAuthorization = sqliteTable(
    "platform_project_authorizations",
    {
        projectId: text("project_id").primaryKey(),
        appId: text("app_id").notNull(),
        tenantId: text("tenant_id").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "suspended", "deleted"] }).notNull(),
    },
    (table) => [
        check(
            "platform_project_authorizations_lifecycle_check",
            sql`${table.lifecycle} in ('active', 'suspended', 'deleted')`,
        ),
    ],
);
