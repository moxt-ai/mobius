import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Merged answer, thought, and tool items of a projected Turn, in the Turn's creation sequence.
export const recordedTurnItem = sqliteTable(
    "recorded_turn_items",
    {
        commandId: text("command_id").notNull(),
        itemId: text("item_id").notNull(),
        sequence: integer("sequence").notNull(),
        itemJson: text("item_json").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.commandId, table.itemId] }),
        uniqueIndex("recorded_turn_items_sequence").on(table.commandId, table.sequence),
    ],
);
