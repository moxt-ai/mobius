import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const standaloneRecordingConfiguration = sqliteTable(
    "standalone_recording_configuration",
    {
        singleton: integer("singleton").primaryKey(),
        enabled: integer("enabled", { mode: "boolean" }).notNull(),
        configuredAt: integer("configured_at").notNull(),
    },
    (table) => [check("standalone_recording_configuration_singleton_check", sql`${table.singleton} = 1`)],
);
