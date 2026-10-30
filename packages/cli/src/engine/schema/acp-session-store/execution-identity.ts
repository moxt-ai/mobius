import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Non-replayable command ownership survives eviction of its detailed receipt. */
export const executionIdentity = sqliteTable("execution_identity", {
    commandId: text("command_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    commandHash: text("command_hash").notNull(),
});
