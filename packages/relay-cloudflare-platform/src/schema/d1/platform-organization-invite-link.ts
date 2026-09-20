import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformOrganizationInviteLink = sqliteTable(
    "platform_organization_invite_links",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        creatorId: text("creator_id").notNull(),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        index("platform_organization_invite_links_organization").on(
            table.organizationId,
            table.revokedAt,
            table.expiresAt,
        ),
    ],
);
