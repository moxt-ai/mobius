import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionQuotaReservation = sqliteTable(
    "session_quota_reservations",
    {
        projectId: text("project_id").notNull(),
        sessionId: text("session_id").notNull(),
        reservedAt: integer("reserved_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.projectId, table.sessionId] }),
        index("session_quota_project").on(table.projectId),
    ],
);
