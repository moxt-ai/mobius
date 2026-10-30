import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Explicit cancellation is a permanent command fact, independent of execution and receipt retention. */
export const cancelledCommand = sqliteTable("cancelled_command", {
    commandId: text("command_id").primaryKey(),
    sessionId: text("session_id").notNull(),
});
