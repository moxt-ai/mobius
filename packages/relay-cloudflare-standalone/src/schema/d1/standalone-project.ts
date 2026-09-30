import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const standaloneProject = sqliteTable("standalone_projects", {
    projectId: text("project_id").primaryKey(),
    ownerTokenHash: text("owner_token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
});
