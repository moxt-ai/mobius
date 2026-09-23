import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const commandReceipts = sqliteTable(
    "command_receipts",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandKind: text("command_kind").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestHash: text("request_hash").notNull(),
        resultId: text("result_id").notNull(),
        acceptedAt: integer("accepted_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeKey, table.sessionId, table.commandKind, table.idempotencyKey] })],
);
