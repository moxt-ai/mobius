import { PROJECT_LOCATION_HINTS } from "@moxt-ai/mobius-sdk/protocol";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const platformProject = sqliteTable(
    "platform_projects",
    {
        projectId: text("project_id").primaryKey(),
        appId: text("app_id").notNull(),
        displayName: text("display_name").notNull(),
        clientReference: text("client_reference").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestDigest: text("request_digest").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "suspended", "deleted"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        suspendedAt: integer("suspended_at"),
        deletedAt: integer("deleted_at"),
        locationHint: text("location_hint", { enum: PROJECT_LOCATION_HINTS }).notNull().default("apac"),
    },
    (table) => [
        check("platform_projects_lifecycle_check", sql`${table.lifecycle} in ('active', 'suspended', 'deleted')`),
        check(
            "platform_projects_location_hint_check",
            sql`${table.locationHint} in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me')`,
        ),
        unique().on(table.appId, table.idempotencyKey),
        unique().on(table.appId, table.clientReference),
        index("platform_projects_app").on(table.appId, table.lifecycle, table.createdAt, table.projectId),
    ],
);
