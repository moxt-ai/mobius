import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const interactions = sqliteTable(
    "interactions",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        interactionId: text("interaction_id").notNull(),
        turnId: text("turn_id").notNull(),
        attemptId: text("attempt_id").notNull(),
        requestJson: text("request_json").notNull(),
        state: text("state", { enum: ["pending", "responded", "resolved", "expired", "cancelled"] }).notNull(),
        responseJson: text("response_json"),
        responderId: text("responder_id"),
        respondedAt: integer("responded_at"),
        resolvedAt: integer("resolved_at"),
    },
    (table) => [
        check("interactions_state_check", sql`state IN ('pending', 'responded', 'resolved', 'expired', 'cancelled')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.interactionId] }),
    ],
);
