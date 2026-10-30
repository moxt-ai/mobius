import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const channelHostCredential = sqliteTable(
    "channel_host_credentials",
    {
        credentialId: text("credential_id").primaryKey(),
        channelId: text("channel_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        authority: text("authority", { enum: ["owner", "linked"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        lastUsedAt: integer("last_used_at").notNull(),
        revokedAt: integer("revoked_at"),
        sourceGrantId: text("source_grant_id").unique(),
    },
    (table) => [
        check("channel_host_credentials_authority_check", sql`${table.authority} in ('owner', 'linked')`),
        index("channel_host_credentials_channel").on(
            table.channelId,
            table.authority,
            table.revokedAt,
            table.createdAt,
        ),
    ],
);
