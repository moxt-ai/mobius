import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const pairingChannel = sqliteTable(
    "pairing_channels",
    {
        pairingId: text("pairing_id").primaryKey(),
        pairingCodeHash: text("pairing_code_hash").notNull().unique(),
        pollTokenHash: text("poll_token_hash").notNull(),
        channelId: text("channel_id").notNull().unique(),
        runtimeId: text("runtime_id").notNull().unique(),
        projectId: text("project_id").notNull(),
        daemonTokenHash: text("daemon_token_hash"),
        status: text("status", { enum: ["pending", "paired", "expired", "revoked"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        claimedAt: integer("claimed_at"),
        machineName: text("machine_name").notNull().default(""),
        workspaceName: text("workspace_name").notNull().default(""),
        agentsJson: text("agents_json").notNull().default("[]"),
        creationIdempotencyKey: text("creation_idempotency_key"),
        createdByOwnerCredentialId: text("created_by_owner_credential_id"),
        runtimeSlot: integer("runtime_slot").notNull(),
        revokedAt: integer("revoked_at"),
        revokedByOwnerCredentialId: text("revoked_by_owner_credential_id"),
    },
    (table) => [
        check("pairing_channels_status_check", sql`${table.status} in ('pending', 'paired', 'expired', 'revoked')`),
        check("pairing_channels_runtime_slot_check", sql`${table.runtimeSlot} > 0`),
        index("pairing_channels_expires_at").on(table.expiresAt),
        index("pairing_channels_project").on(table.projectId, table.channelId),
        index("pairing_channels_project_runtime").on(table.projectId, table.runtimeId),
        index("pairing_channels_project_listing").on(table.projectId, table.status, table.createdAt, table.channelId),
        uniqueIndex("pairing_channels_creation_idempotency")
            .on(table.projectId, table.creationIdempotencyKey)
            .where(sql`${table.creationIdempotencyKey} is not null`),
        uniqueIndex("pairing_channels_active_runtime_slot")
            .on(table.projectId, table.runtimeSlot)
            .where(sql`${table.status} in ('pending', 'paired')`),
    ],
);
