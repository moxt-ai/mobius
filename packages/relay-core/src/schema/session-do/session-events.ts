import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const sessionEvents = sqliteTable(
    "session_events",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        sequenceNumber: integer("sequence_number").notNull(),
        eventId: text("event_id").notNull(),
        payloadHash: text("payload_hash").notNull(),
        sourceKind: text("source_kind", { enum: ["attempt", "runtime"] }).notNull(),
        sourceId: text("source_id").notNull(),
        sourceSeq: text("source_seq").notNull(),
        payload: text("payload"),
        archiveSegmentId: text("archive_segment_id").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check("session_events_source_kind_check", sql`source_kind IN ('attempt', 'runtime')`),
        primaryKey({ columns: [table.scopeKey, table.sessionId, table.sequenceNumber] }),
        unique("session_events_scope_key_session_id_event_id_unique").on(
            table.scopeKey,
            table.sessionId,
            table.eventId,
        ),
        unique("session_events_scope_key_session_id_source_kind_source_id_source_seq_unique").on(
            table.scopeKey,
            table.sessionId,
            table.sourceKind,
            table.sourceId,
            table.sourceSeq,
        ),
    ],
);
