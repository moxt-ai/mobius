import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One projected Turn per command, maintained as Recording batches are folded in append order.
export const recordedTurn = sqliteTable(
    "recorded_turns",
    {
        commandId: text("command_id").primaryKey(),
        // Creation order inside the Session; Turn history pages walk it newest first.
        turnOrder: integer("turn_order").notNull().unique(),
        // Set while the attempt has started and not ended, so a Session generation change can find it.
        open: integer("open", { mode: "boolean" }).notNull(),
        turnJson: text("turn_json").notNull(),
    },
    (table) => [index("recorded_turns_open").on(table.open)],
);
