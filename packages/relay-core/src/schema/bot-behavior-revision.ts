import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const botBehaviorRevision = sqliteTable(
    "bot_behavior_revisions",
    {
        behaviorRevisionId: text("behavior_revision_id").primaryKey(),
        botId: text("bot_id").notNull(),
        revisionNumber: integer("revision_number").notNull(),
        instructions: text("instructions").notNull(),
        requiredCapabilitiesJson: text("required_capabilities_json").notNull(),
        agentConfigurationJson: text("agent_configuration_json").notNull(),
        contentDigest: text("content_digest").notNull(),
        lifecycle: text("lifecycle", {
            enum: ["proposed", "awaiting_local_approval", "approved", "retired"],
        }).notNull(),
        createdAt: integer("created_at").notNull(),
        approvedAt: integer("approved_at"),
        retiredAt: integer("retired_at"),
    },
    (table) => [
        check("bot_behavior_revisions_revision_number_check", sql`${table.revisionNumber} > 0`),
        check(
            "bot_behavior_revisions_lifecycle_check",
            sql`${table.lifecycle} in ('proposed', 'awaiting_local_approval', 'approved', 'retired')`,
        ),
        unique().on(table.botId, table.revisionNumber),
        unique().on(table.botId, table.behaviorRevisionId),
        uniqueIndex("bot_behavior_revisions_approved").on(table.botId).where(sql`${table.lifecycle} = 'approved'`),
    ],
);
