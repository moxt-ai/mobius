import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformProjectAppRevocation = sqliteTable("platform_project_app_revocations", {
    appId: text("app_id").primaryKey(),
});
