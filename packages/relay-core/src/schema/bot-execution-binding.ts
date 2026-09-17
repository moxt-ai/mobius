import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const botExecutionBinding = sqliteTable(
    "bot_execution_bindings",
    {
        bindingId: text("binding_id").primaryKey(),
        botId: text("bot_id").notNull(),
        behaviorRevisionId: text("behavior_revision_id").notNull(),
        bindingRevision: integer("binding_revision").notNull(),
        runtimeId: text("runtime_id").notNull(),
        agentRef: text("agent_ref").notNull(),
        workspaceRef: text("workspace_ref").notNull(),
        agentConfigRevision: integer("agent_config_revision").notNull(),
        allowedDeliveryTargetIdsJson: text("allowed_delivery_target_ids_json").notNull(),
        completionPolicyJson: text("completion_policy_json").notNull(),
        lifecycle: text("lifecycle", { enum: ["requested", "approved", "unavailable", "revoked"] }).notNull(),
        localGrantId: text("local_grant_id"),
        agentIdentityDigest: text("agent_identity_digest"),
        workspaceIdentityDigest: text("workspace_identity_digest"),
        createdAt: integer("created_at").notNull(),
        approvedAt: integer("approved_at"),
        unavailableAt: integer("unavailable_at"),
        revokedAt: integer("revoked_at"),
        unavailableCode: text("unavailable_code"),
        unavailableMessage: text("unavailable_message"),
    },
    (table) => [
        check("bot_execution_bindings_binding_revision_check", sql`${table.bindingRevision} > 0`),
        check("bot_execution_bindings_agent_config_revision_check", sql`${table.agentConfigRevision} > 0`),
        check(
            "bot_execution_bindings_lifecycle_check",
            sql`${table.lifecycle} in ('requested', 'approved', 'unavailable', 'revoked')`,
        ),
        unique().on(table.botId, table.bindingRevision),
        unique().on(table.botId, table.bindingId),
        uniqueIndex("bot_execution_bindings_requested").on(table.botId).where(sql`${table.lifecycle} = 'requested'`),
    ],
);
