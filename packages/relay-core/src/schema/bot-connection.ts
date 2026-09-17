import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botConnection = sqliteTable(
    "bot_connections",
    {
        connectionId: text("connection_id").primaryKey(),
        botId: text("bot_id").notNull(),
        connectorPrincipalId: text("connector_principal_id").notNull(),
        audience: text("audience").notNull(),
        label: text("label").notNull(),
        scopesJson: text("scopes_json").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "revoked"] }).notNull(),
        lifecycleRevision: integer("lifecycle_revision").notNull(),
        createdAt: integer("created_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
        sourceGrantId: text("source_grant_id").notNull().unique(),
    },
    (table) => [
        check("bot_connections_lifecycle_check", sql`${table.lifecycle} in ('active', 'revoked')`),
        check("bot_connections_lifecycle_revision_check", sql`${table.lifecycleRevision} > 0`),
        index("bot_connections_bot").on(table.botId, table.lifecycle, desc(table.createdAt)),
    ],
);
