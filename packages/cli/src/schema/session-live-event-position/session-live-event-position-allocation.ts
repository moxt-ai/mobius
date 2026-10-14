import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionLiveEventPositionAllocation = sqliteTable("session_live_event_position_allocation", {
    allocatedPosition: integer("allocated_position").notNull().default(10_000_000),
    sessionId: text("session_id").primaryKey(),
});
