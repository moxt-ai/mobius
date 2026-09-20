import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const turns = sqliteTable(
    "turns",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandId: text("command_id").notNull(),
        turnId: text("turn_id").notNull(),
        bindingId: text("binding_id").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestHash: text("request_hash").notNull(),
        commandJson: text("command_json").notNull(),
        state: text("state", {
            enum: ["queued", "running", "succeeded", "failed", "cancelled", "indeterminate"],
        }).notNull(),
        response: text("response").notNull().default(""),
        attemptId: text("attempt_id"),
        startedAt: integer("started_at"),
        completedAt: integer("completed_at"),
        stopReason: text("stop_reason"),
        errorCode: text("error_code"),
        errorMessage: text("error_message"),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "turns_state_check",
            sql`state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate')`,
        ),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.commandId] }),
        unique("turns_scope_key_session_id_turn_id_unique").on(table.scopeKey, table.sessionId, table.turnId),
        unique("turns_scope_key_session_id_idempotency_key_unique").on(
            table.scopeKey,
            table.sessionId,
            table.idempotencyKey,
        ),
        index("turns_page").on(table.scopeKey, table.sessionId, table.createdAt, table.commandId),
    ],
);
