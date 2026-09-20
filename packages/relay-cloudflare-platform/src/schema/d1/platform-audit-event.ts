import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const platformAuditEvent = sqliteTable(
    "platform_audit_events",
    {
        auditId: text("audit_id").primaryKey(),
        appId: text("app_id").notNull(),
        projectId: text("project_id").notNull(),
        actorKind: text("actor_kind").notNull(),
        actorId: text("actor_id").notNull(),
        actorRef: text("actor_ref").notNull(),
        action: text("action").notNull(),
        subjectId: text("subject_id").notNull(),
        outcome: text("outcome", { enum: ["succeeded", "denied"] }).notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check("platform_audit_events_project_id_check", sql`${table.projectId} != ''`),
        check("platform_audit_events_outcome_check", sql`${table.outcome} in ('succeeded', 'denied')`),
        index("platform_audit_events_project").on(table.projectId, desc(table.recordedAt), desc(table.auditId)),
    ],
);
