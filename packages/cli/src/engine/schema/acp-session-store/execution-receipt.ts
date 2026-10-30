import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const executionReceipt = sqliteTable("execution_receipt", {
    commandId: text("command_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    commandHash: text("command_hash").notNull(),
    attemptId: text("attempt_id").notNull(),
    admissionOrder: integer("admission_order").notNull(),
    started: integer("started", { mode: "boolean" }).notNull(),
    outcome: text("outcome"),
    updatedAt: text("updated_at").notNull(),
});
