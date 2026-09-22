import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const turns = sqliteTable(
    "turns",
    {
        scope_key: text("scope_key").notNull(),
        session_id: text("session_id").notNull(),
        command_id: text("command_id").notNull(),
        turn_id: text("turn_id").notNull(),
        binding_id: text("binding_id").notNull(),
        idempotency_key: text("idempotency_key").notNull(),
        request_hash: text("request_hash").notNull(),
        command_json: text("command_json").notNull(),
        state: text("state", {
            enum: ["queued", "running", "succeeded", "failed", "cancelled", "indeterminate"],
        }).notNull(),
        response: text("response").notNull().default(""),
        attempt_id: text("attempt_id"),
        started_at: integer("started_at"),
        completed_at: integer("completed_at"),
        stop_reason: text("stop_reason"),
        error_code: text("error_code"),
        error_message: text("error_message"),
        created_at: integer("created_at").notNull(),
        updated_at: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "turns_state_check",
            sql`state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate')`,
        ),
        primaryKey({ columns: [table.scope_key, table.session_id, table.command_id] }),
        unique("turns_scope_key_session_id_turn_id_unique").on(table.scope_key, table.session_id, table.turn_id),
        unique("turns_scope_key_session_id_idempotency_key_unique").on(
            table.scope_key,
            table.session_id,
            table.idempotency_key,
        ),
        index("turns_page").on(table.scope_key, table.session_id, table.created_at, table.command_id),
    ],
);
