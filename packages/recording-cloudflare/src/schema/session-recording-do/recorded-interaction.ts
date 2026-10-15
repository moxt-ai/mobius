import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Permission and elicitation requests, kept until the Recording resolves them.
export const recordedInteraction = sqliteTable(
    "recorded_interactions",
    {
        interactionId: text("interaction_id").primaryKey(),
        commandId: text("command_id").notNull(),
        resolved: integer("resolved", { mode: "boolean" }).notNull(),
        requestJson: text("request_json").notNull(),
    },
    (table) => [index("recorded_interactions_resolved").on(table.resolved)],
);
