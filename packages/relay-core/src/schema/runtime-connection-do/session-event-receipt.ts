import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionEventReceipt = sqliteTable(
    "reliable_event_receipts",
    {
        eventId: text("event_id").primaryKey(),
        envelopeHash: text("envelope_hash").notNull(),
        receivedAt: integer("received_at").notNull(),
    },
    (table) => [index("reliable_event_receipts_received").on(table.receivedAt, table.eventId)],
);
