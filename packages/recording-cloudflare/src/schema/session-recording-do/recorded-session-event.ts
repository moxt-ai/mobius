import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordedSessionEvent = sqliteTable(
    "recorded_session_events_v2",
    {
        firstPosition: integer("first_position"),
        // The final event position inside the stored envelope batch. Positions increase within a
        // Session, so incremental readers seek straight past batches that end at or before their
        // cursor. Rows recorded before the column existed stay null and read through a full scan.
        lastPosition: integer("last_position"),
        ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
        envelopeJson: text("envelope_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
        // Server receipt time survives projection rebuilds and does not trust the Runtime's clock.
        receivedAt: integer("received_at"),
        sessionGenerationId: text("session_generation_id"),
    },
    (table) => [index("recorded_session_events_v2_last_position").on(table.lastPosition)],
);
