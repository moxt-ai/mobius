import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Directory operations committed with their Recording batch that the directory index has not yet confirmed.
export const pendingDirectoryUpdate = sqliteTable("pending_directory_updates", {
    ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
    operationsJson: text("operations_json").notNull(),
    events: integer("events").notNull(),
});
