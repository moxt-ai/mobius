import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runtimeRevocation = sqliteTable(
    "runtime_revocations",
    {
        runtimeId: text("runtime_id").notNull(),
        projectId: text("project_id").notNull(),
        revokedAt: integer("revoked_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.runtimeId, table.projectId] })],
);
