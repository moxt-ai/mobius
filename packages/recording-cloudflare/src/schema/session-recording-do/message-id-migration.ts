import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messageIdMigration = sqliteTable("message_id_migration", {
    singleton: integer("singleton").primaryKey(),
    progressJson: text("progress_json").notNull(),
});
