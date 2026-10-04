import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordedSessionEvent = sqliteTable("recorded_session_events", {
    ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
    envelopeJson: text("envelope_json").notNull(),
    recordedAt: integer("recorded_at").notNull(),
});
