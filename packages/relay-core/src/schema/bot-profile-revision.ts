import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const botProfileRevision = sqliteTable(
    "bot_profile_revisions",
    {
        profileRevisionId: text("profile_revision_id").primaryKey(),
        botId: text("bot_id").notNull(),
        revisionNumber: integer("revision_number").notNull(),
        displayName: text("display_name").notNull(),
        avatarRef: text("avatar_ref").notNull(),
        description: text("description").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        check("bot_profile_revisions_revision_number_check", sql`${table.revisionNumber} > 0`),
        unique().on(table.botId, table.revisionNumber),
        unique().on(table.botId, table.profileRevisionId),
    ],
);
