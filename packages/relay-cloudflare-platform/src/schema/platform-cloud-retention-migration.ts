import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformCloudRetentionMigration = sqliteTable("platform_cloud_retention_migrations", {
    projectId: text("project_id").primaryKey(),
    sessionCount: integer("session_count").notNull(),
    completedAt: integer("completed_at").notNull(),
});
