import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const identityActorKinds = ["application", "browser_access", "external_identity"] as const;

export const externalIdentityProjectGrant = sqliteTable(
    "external_identity_project_grants",
    {
        grantId: text("grant_id").primaryKey(),
        bindingId: text("binding_id").notNull(),
        projectId: text("project_id").notNull(),
        permissionsJson: text("permissions_json").notNull(),
        createdByActorKind: text("created_by_actor_kind", { enum: identityActorKinds }).notNull(),
        createdByActorId: text("created_by_actor_id").notNull(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        check(
            "external_identity_project_grants_created_by_actor_kind_check",
            sql`${table.createdByActorKind} in ('application', 'browser_access', 'external_identity')`,
        ),
        uniqueIndex("external_identity_project_grants_active")
            .on(table.bindingId, table.projectId)
            .where(sql`${table.revokedAt} is null`),
        index("external_identity_project_grants_project").on(table.projectId, table.revokedAt, desc(table.createdAt)),
    ],
);
