import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Replayed raw frames must receive the same identity even when they are no longer adjacent.
export const legacyMessageIdentity = sqliteTable(
    "legacy_message_identities",
    {
        generationId: text("generation_id").notNull(),
        eventId: text("event_id").notNull(),
        messageId: text("message_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.generationId, table.eventId] })],
);
