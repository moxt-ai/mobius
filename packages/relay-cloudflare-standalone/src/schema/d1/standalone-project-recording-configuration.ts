import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const standaloneProjectRecordingConfiguration = sqliteTable("standalone_project_recording_configurations", {
    projectId: text("project_id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    configuredAt: integer("configured_at").notNull(),
});
