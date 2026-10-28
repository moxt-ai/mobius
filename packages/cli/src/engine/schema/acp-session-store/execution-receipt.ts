import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const executionReceipt = sqliteTable("execution_receipt", {
    commandId: text("command_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    commandHash: text("command_hash").notNull(),
    attemptId: text("attempt_id").notNull(),
    // Nullable only for receipts written by older Runtimes; assigned before recovery.
    admissionOrder: integer("admission_order"),
    // Compatibility projection for older Runtimes; started and outcome own the facts.
    state: text("state").notNull(),
    started: integer("started", { mode: "boolean" }).notNull(),
    outcome: text("outcome"),
    updatedAt: text("updated_at").notNull(),
});
