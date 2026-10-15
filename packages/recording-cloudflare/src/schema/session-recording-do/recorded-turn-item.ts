import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Merged answer, thought, and tool items of a projected Turn, in the Turn's creation sequence.
export const recordedTurnItem = sqliteTable(
    "recorded_turn_items",
    {
        commandId: text("command_id").notNull(),
        itemId: text("item_id").notNull(),
        sequence: integer("sequence").notNull(),
        // Item fields without answer or thought text, which lives in `text` so chunks append in place.
        itemJson: text("item_json").notNull(),
        text: text("text").notNull().default(""),
        // The bounded tool item that pages list; text items are bounded from `text` when read.
        listingJson: text("listing_json"),
    },
    (table) => [
        primaryKey({ columns: [table.commandId, table.itemId] }),
        uniqueIndex("recorded_turn_items_sequence").on(table.commandId, table.sequence),
        // Finds the Turn that started a tool call when a later update arrives under another command.
        index("recorded_turn_items_item").on(table.itemId),
    ],
);
