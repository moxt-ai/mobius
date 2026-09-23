import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const attempts = sqliteTable(
    "attempts",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        attemptId: text("attempt_id").notNull(),
        turnId: text("turn_id").notNull(),
        bindingId: text("binding_id").notNull(),
        state: text("state", {
            enum: ["dispatching", "running", "waiting_input", "succeeded", "failed", "cancelled", "indeterminate"],
        }).notNull(),
        startedAt: integer("started_at").notNull(),
        waitingInteractionIdsJson: text("waiting_interaction_ids_json").notNull().default("[]"),
        completedAt: integer("completed_at"),
        stopReason: text("stop_reason"),
        errorCode: text("error_code"),
        errorMessage: text("error_message"),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "attempts_state_check",
            sql`state IN ('dispatching', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'indeterminate')`,
        ),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.attemptId] }),
        unique("attempts_scope_key_session_id_turn_id_attempt_id_unique").on(
            table.scopeKey,
            table.sessionId,
            table.turnId,
            table.attemptId,
        ),
    ],
);
