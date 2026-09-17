import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const botControlOutbox = sqliteTable(
    "bot_control_outbox",
    {
        outboxId: text("outbox_id").primaryKey(),
        botId: text("bot_id").notNull(),
        subjectId: text("subject_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        messageKind: text("message_kind", { enum: ["binding_approval", "conversation_provisioning"] }).notNull(),
        payload: text("payload").notNull(),
        state: text("state", { enum: ["pending", "completed", "failed"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        completedAt: integer("completed_at"),
        failureCode: text("failure_code"),
    },
    (table) => [
        check(
            "bot_control_outbox_message_kind_check",
            sql`${table.messageKind} in ('binding_approval', 'conversation_provisioning')`,
        ),
        check("bot_control_outbox_state_check", sql`${table.state} in ('pending', 'completed', 'failed')`),
        unique().on(table.subjectId, table.messageKind),
        index("bot_control_outbox_runtime").on(table.runtimeId, table.state, table.createdAt, table.outboxId),
    ],
);
