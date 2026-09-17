import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botAuditEvent = sqliteTable(
    "bot_audit_events",
    {
        auditId: text("audit_id").primaryKey(),
        projectId: text("project_id").notNull(),
        botId: text("bot_id").notNull(),
        actorKind: text("actor_kind").notNull(),
        actorId: text("actor_id").notNull(),
        action: text("action").notNull(),
        subjectId: text("subject_id").notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        index("bot_audit_events_bot").on(table.projectId, table.botId, desc(table.recordedAt), desc(table.auditId)),
    ],
);
