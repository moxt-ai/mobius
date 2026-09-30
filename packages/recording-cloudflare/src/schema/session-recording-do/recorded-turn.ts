import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordedTurn = sqliteTable(
    "recorded_turns",
    {
        attemptId: text("attempt_id").notNull(),
        commandId: text("command_id").primaryKey(),
        createdAt: integer("created_at").notNull(),
        settledAt: integer("settled_at"),
        startedOrdinal: integer("started_ordinal").notNull(),
        state: text("state", { enum: ["running", "completed", "failed"] }).notNull(),
        terminalOrdinal: integer("terminal_ordinal"),
    },
    (table) => [
        check(
            "recorded_turns_terminal_state_check",
            sql`(${table.state} = 'running' AND ${table.terminalOrdinal} IS NULL AND ${table.settledAt} IS NULL) OR (${table.state} IN ('completed', 'failed') AND ${table.terminalOrdinal} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`,
        ),
    ],
);
