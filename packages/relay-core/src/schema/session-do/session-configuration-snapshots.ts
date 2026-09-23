import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionConfigurationSnapshots = sqliteTable(
    "session_configuration_snapshots",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        configRevision: integer("config_revision").notNull(),
        configOptionsJson: text("config_options_json").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeKey, table.sessionId] })],
);
