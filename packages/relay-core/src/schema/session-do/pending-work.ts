import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const pendingWork = sqliteTable(
    "pending_work",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        workId: text("work_id").notNull(),
        workKind: text("work_kind", {
            enum: ["archive", "delete", "dispatch", "interaction_response", "projection"],
        }).notNull(),
        runtimeId: text("runtime_id").notNull(),
        interactionId: text("interaction_id"),
        deliveryPayload: text("delivery_payload"),
        state: text("state", { enum: ["pending", "running", "completed", "retryable", "failed"] }).notNull(),
        queuedAt: integer("queued_at").notNull(),
        startedAt: integer("started_at"),
        completedAt: integer("completed_at"),
        nextAttemptAt: integer("next_attempt_at"),
        attemptCount: integer("attempt_count").notNull().default(0),
        errorCode: text("error_code"),
        errorMessage: text("error_message"),
    },
    (table) => [
        check(
            "pending_work_work_kind_check",
            sql`work_kind IN ('archive', 'delete', 'dispatch', 'interaction_response', 'projection')`,
        ),
        check("pending_work_state_check", sql`state IN ('pending', 'running', 'completed', 'retryable', 'failed')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.workId] }),
        unique("pending_work_scope_key_session_id_interaction_id_unique").on(
            table.scopeKey,
            table.sessionId,
            table.interactionId,
        ),
        index("pending_work_delivery").on(table.scopeKey, table.runtimeId, table.state, table.queuedAt, table.workId),
    ],
);
