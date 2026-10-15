import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const platformAppUpgrade = sqliteTable("platform_app_upgrades", {
    appId: text("app_id").primaryKey(),
    revision: text("revision").notNull(),
    version: text("version").notNull(),
    percentage: integer("percentage").notNull(),
    updatedAt: integer("updated_at").notNull(),
});
