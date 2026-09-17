import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const botDeliveryTarget = sqliteTable(
    "bot_delivery_targets",
    {
        deliveryTargetId: text("delivery_target_id").primaryKey(),
        botId: text("bot_id").notNull(),
        connectionId: text("connection_id").notNull(),
        alias: text("alias").notNull(),
        outboundPolicyRevision: integer("outbound_policy_revision").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "disabled"] }).notNull(),
        lifecycleRevision: integer("lifecycle_revision").notNull(),
        ownerApproved: integer("owner_approved").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        disabledAt: integer("disabled_at"),
    },
    (table) => [
        check("bot_delivery_targets_outbound_policy_revision_check", sql`${table.outboundPolicyRevision} >= 0`),
        check("bot_delivery_targets_lifecycle_check", sql`${table.lifecycle} in ('active', 'disabled')`),
        check("bot_delivery_targets_lifecycle_revision_check", sql`${table.lifecycleRevision} > 0`),
        check("bot_delivery_targets_owner_approved_check", sql`${table.ownerApproved} in (0, 1)`),
        unique().on(table.connectionId, table.alias),
        unique().on(table.botId, table.deliveryTargetId),
        index("bot_delivery_targets_connection").on(table.connectionId, table.lifecycle, table.createdAt),
    ],
);
