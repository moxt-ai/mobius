import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const runtimeUpgradeState = sqliteTable("runtime_upgrade_state", {
    projectId: text("project_id").notNull(),
    runtimeId: text("runtime_id").primaryKey(),
    lastSeen: integer("last_seen").notNull(),
    version: text("version"),
    attempt: text("attempt"),
    latest: text("latest"),
    lastFailure: text("last_failure"),
});
