import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Permission and elicitation requests. A request closes when the Recording resolves it or when its
// Turn can no longer consume an answer.
export const recordedInteraction = sqliteTable(
    "recorded_interactions",
    {
        interactionId: text("interaction_id").primaryKey(),
        commandId: text("command_id").notNull(),
        resolved: integer("resolved", { mode: "boolean" }).notNull(),
        requestedAt: integer("requested_at").notNull(),
        requestJson: text("request_json").notNull(),
    },
    (table) => [
        index("recorded_interactions_pending").on(table.resolved, table.requestedAt, table.interactionId),
        index("recorded_interactions_command").on(table.commandId, table.resolved),
    ],
);
