import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botConnectionGrant = sqliteTable(
    "bot_connection_grants",
    {
        grantId: text("grant_id").primaryKey(),
        botId: text("bot_id").notNull(),
        audience: text("audience").notNull(),
        label: text("label").notNull(),
        scopesJson: text("scopes_json").notNull(),
        secretDigest: text("secret_digest").notNull().unique(),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        consumedAt: integer("consumed_at"),
        consumedConnectionId: text("consumed_connection_id"),
    },
    (table) => [index("bot_connection_grants_bot").on(table.botId, desc(table.createdAt))],
);
