import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Rebuildable identities already applied to Turn history; received frames remain in Recording.
export const projectedSessionEvent = sqliteTable(
    "projected_session_events",
    {
        generationId: text("generation_id").notNull(),
        eventId: text("event_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.generationId, table.eventId] })],
);
