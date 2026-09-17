import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bot = sqliteTable(
    "bots",
    {
        botId: text("bot_id").primaryKey(),
        projectId: text("project_id").notNull(),
        currentProfileRevisionId: text("current_profile_revision_id").notNull(),
        activeBehaviorRevisionId: text("active_behavior_revision_id"),
        activeBindingId: text("active_binding_id"),
        lifecycle: text("lifecycle", { enum: ["draft", "active", "suspended", "archived"] }).notNull(),
        lifecycleRevision: integer("lifecycle_revision").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        suspendedAt: integer("suspended_at"),
        archivedAt: integer("archived_at"),
    },
    (table) => [
        check("bots_lifecycle_check", sql`${table.lifecycle} in ('draft', 'active', 'suspended', 'archived')`),
        check("bots_lifecycle_revision_check", sql`${table.lifecycleRevision} > 0`),
        index("bots_project").on(table.projectId, table.lifecycle, desc(table.updatedAt), desc(table.botId)),
    ],
);
