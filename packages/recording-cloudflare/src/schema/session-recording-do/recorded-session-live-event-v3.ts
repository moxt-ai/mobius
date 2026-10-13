import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordedSessionLiveEventV3 = sqliteTable("recorded_session_live_events_v3", {
    eventJson: text("event_json").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    seq: integer("seq").primaryKey(),
});
