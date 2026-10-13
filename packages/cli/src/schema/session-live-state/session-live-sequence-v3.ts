import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionLiveSequenceV3 = sqliteTable("session_live_sequence_v3", {
    sessionId: text("session_id").primaryKey(),
    maxSeq: integer("max_seq").notNull(),
});
