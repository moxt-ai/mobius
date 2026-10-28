import { and, eq, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { PlatformAuditRecord } from "../entity/platform-records.ts";
import { platformApp, platformDashboardAuditEvent } from "../schema/d1/index.ts";
import type { PlatformDrizzleDatabase } from "./platform-drizzle-database.ts";

/** Configuration writes and their success audits use the same live App predicate inside a D1 batch. */
export function activeAppConfigurationTarget(database: PlatformDrizzleDatabase, appId: string | SQLiteColumn) {
    return database
        .select({ appId: platformApp.appId })
        .from(platformApp)
        .where(and(eq(platformApp.appId, appId), eq(platformApp.lifecycle, "active")));
}

export function appConfigurationAudit(database: PlatformDrizzleDatabase, audit: PlatformAuditRecord, condition?: SQL) {
    const target = activeAppConfigurationTarget(database, audit.appId).as("active_app");
    return database
        .insert(platformDashboardAuditEvent)
        .select(
            database
                .select({
                    auditId: sql<string>`${audit.auditId}`.as("auditId"),
                    tenantId: sql<string>`${audit.tenantId}`.as("tenantId"),
                    appId: sql<string>`${audit.appId}`.as("appId"),
                    projectId: sql<string>`${audit.projectId}`.as("projectId"),
                    actorKind: sql<string>`${audit.actorKind}`.as("actorKind"),
                    actorId: sql<string>`${audit.actorId}`.as("actorId"),
                    actorRef: sql<string>`${audit.actorRef}`.as("actorRef"),
                    action: sql<string>`${audit.action}`.as("action"),
                    subjectId: sql<string>`${audit.subjectId}`.as("subjectId"),
                    outcome: sql<"succeeded" | "denied">`${audit.outcome}`.as("outcome"),
                    detailsJson: sql<string>`${audit.detailsJson}`.as("detailsJson"),
                    recordedAt: sql<number>`${audit.recordedAt}`.as("recordedAt"),
                })
                .from(target)
                .where(condition),
        )
        .returning({ auditId: platformDashboardAuditEvent.auditId });
}
