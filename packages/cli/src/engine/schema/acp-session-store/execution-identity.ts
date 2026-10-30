import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The fact that a command started survives eviction of its replayable receipt. */
export const executionIdentity = sqliteTable("execution_identity", {
    commandId: text("command_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    commandHash: text("command_hash").notNull(),
});
