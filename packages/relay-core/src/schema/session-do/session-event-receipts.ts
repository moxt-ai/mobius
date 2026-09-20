import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionEventReceipts = sqliteTable(
    "session_event_receipts",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        sourceKind: text("source_kind", { enum: ["attempt", "runtime"] }).notNull(),
        sourceId: text("source_id").notNull(),
        eventId: text("event_id").notNull(),
        payloadHash: text("payload_hash").notNull(),
        sourceSeq: text("source_seq").notNull(),
        sequenceNumber: integer("sequence_number").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check("session_event_receipts_source_kind_check", sql`source_kind IN ('attempt', 'runtime')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.sourceKind, table.sourceId] }),
        index("session_event_receipts_event").on(table.scopeKey, table.sessionId, table.eventId),
    ],
);
