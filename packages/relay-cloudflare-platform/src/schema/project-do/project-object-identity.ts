import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projectObjectIdentity = sqliteTable(
    "project_object_identity",
    {
        singleton: integer("singleton").primaryKey(),
        projectId: text("project_id").notNull().unique(),
    },
    (table) => [check("project_object_identity_singleton_check", sql`${table.singleton} = 1`)],
);
