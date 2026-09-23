import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runtimeDisconnect = sqliteTable(
    "runtime_disconnect",
    {
        singleton: integer("singleton").primaryKey(),
        jobJson: text("job_json").notNull(),
    },
    (table) => [check("runtime_disconnect_singleton_check", sql`${table.singleton} = 1`)],
);
