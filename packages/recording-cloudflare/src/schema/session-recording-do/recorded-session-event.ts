import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordedSessionEvent = sqliteTable(
    "recorded_session_events",
    {
        ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
        eventId: text("event_id").notNull().unique(),
        envelopeJson: text("envelope_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
        sourceSeq: text("source_seq").notNull(),
        streamId: text("stream_id").notNull(),
    },
    (table) => [index("recorded_session_events_stream_order").on(table.streamId, table.sourceSeq)],
);
