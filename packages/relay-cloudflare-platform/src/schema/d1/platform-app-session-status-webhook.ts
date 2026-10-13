import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformAppSessionStatusWebhook = sqliteTable(
    "platform_app_session_status_webhooks",
    {
        appId: text("app_id").primaryKey(),
        enabled: integer("enabled").notNull(),
        endpoint: text("endpoint").notNull(),
        secretId: text("secret_id").notNull(),
        secretCiphertext: text("secret_ciphertext").notNull(),
        secretNonce: text("secret_nonce").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [check("platform_app_webhooks_enabled_check", sql`${table.enabled} in (0, 1)`)],
);
