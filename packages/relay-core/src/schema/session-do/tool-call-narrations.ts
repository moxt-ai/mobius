import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Append-only increments of a streamed narration activity (reasoning or progress).
 *
 * The Agent rewrites a narration once per streamed chunk, and a Turn keeps its raw
 * events until it terminates. Persisting the accumulated text on every chunk made the
 * bytes retained for one Turn grow with the square of the narration length, which is
 * what could exhaust a Session. Each row holds only what one chunk added, so retained
 * bytes stay proportional to the narration itself. `tool_call_views` keeps the bounded
 * terminal snapshot; these rows are deleted in the same commit that writes it.
 */
export const toolCallNarrations = sqliteTable(
    "tool_call_narrations",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        commandId: text("command_id").notNull(),
        attemptId: text("attempt_id").notNull(),
        activityId: text("activity_id").notNull(),
        sequence: integer("sequence").notNull(),
        text: text("text").notNull(),
    },
    (table) => [
        check("tool_call_narrations_sequence_check", sql`sequence >= 0`),
        primaryKey({
            columns: [table.scopeKey, table.sessionId, table.attemptId, table.activityId, table.sequence],
        }),
        index("tool_call_narrations_command").on(table.scopeKey, table.sessionId, table.commandId),
    ],
);
