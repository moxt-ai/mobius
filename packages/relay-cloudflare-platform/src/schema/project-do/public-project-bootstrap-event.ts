import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const publicProjectBootstrapEvent = sqliteTable(
    "public_project_bootstrap_events",
    {
        eventId: text("event_id").primaryKey(),
        clientFingerprint: text("client_fingerprint").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        index("public_project_bootstrap_events_limit").on(table.clientFingerprint, desc(table.createdAt)),
        index("public_project_bootstrap_events_retention").on(table.createdAt),
    ],
);
