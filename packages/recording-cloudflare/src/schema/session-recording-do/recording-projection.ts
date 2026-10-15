import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Session-wide fold state of the Turn history projection.
export const recordingProjection = sqliteTable(
    "recording_projection",
    {
        singleton: integer("singleton").primaryKey(),
        // The last Recording batch folded into the projection; batches fold strictly in append order.
        foldedThroughOrdinal: integer("folded_through_ordinal").notNull(),
        turnCount: integer("turn_count").notNull(),
        stateJson: text("state_json").notNull(),
    },
    (table) => [check("recording_projection_singleton_check", sql`${table.singleton} = 1`)],
);
