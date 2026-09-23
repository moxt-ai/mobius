import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const authenticationActorKinds = ["application", "browser_access", "external_identity"] as const;

export const authenticationAuditEvent = sqliteTable(
    "authentication_audit_events",
    {
        auditId: text("audit_id").primaryKey(),
        projectId: text("project_id").notNull(),
        actorKind: text("actor_kind", { enum: authenticationActorKinds }).notNull(),
        actorId: text("actor_id").notNull(),
        actorRef: text("actor_ref").notNull(),
        action: text("action").notNull(),
        subjectId: text("subject_id").notNull(),
        outcome: text("outcome", { enum: ["succeeded", "denied"] }).notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check(
            "authentication_audit_events_actor_kind_check",
            sql`${table.actorKind} in ('application', 'browser_access', 'external_identity')`,
        ),
        check("authentication_audit_events_outcome_check", sql`${table.outcome} in ('succeeded', 'denied')`),
        index("authentication_audit_events_project").on(table.projectId, desc(table.recordedAt), desc(table.auditId)),
    ],
);
