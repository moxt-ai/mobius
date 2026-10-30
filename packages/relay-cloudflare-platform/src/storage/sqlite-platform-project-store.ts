import { relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { SqliteProjectStore } from "@moxt-ai/mobius-relay-core/project-store";
import { and, desc, eq } from "drizzle-orm";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import { platformAppCredentialProject, platformAuditEvent } from "../schema/project-do/index.ts";

/**
 * A Project's Relay and Platform operations over its own SQLite storage. Only the Project Durable Object
 * constructs this; everything else reaches these tables through its operations.
 */
export class SqlitePlatformProjectStore extends SqliteProjectStore implements PlatformProjectStore {
    readonly #projectId: string;
    readonly #database: SqlDatabase;

    constructor(projectId: string, database: SqlDatabase) {
        super(projectId, database);
        this.#projectId = projectId;
        this.#database = database;
    }

    readonly recordAudit: PlatformProjectStore["recordAudit"] = async (audit, signal) => {
        await relayDrizzle(this.#database, signal)
            .insert(platformAuditEvent)
            .values({
                auditId: audit.action === "project.created" ? `pae_created_${this.#projectId}` : audit.auditId,
                appId: audit.appId,
                projectId: this.#projectId,
                actorKind: audit.actorKind,
                actorId: audit.actorId,
                actorRef: audit.actorRef,
                action: audit.action,
                subjectId: audit.subjectId,
                outcome: audit.outcome === "succeeded" ? "succeeded" : "denied",
                detailsJson: audit.detailsJson,
                recordedAt: audit.recordedAt,
            })
            .onConflictDoNothing({ target: platformAuditEvent.auditId });
    };

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = async (limit, signal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select()
            .from(platformAuditEvent)
            .where(eq(platformAuditEvent.projectId, this.#projectId))
            .orderBy(desc(platformAuditEvent.recordedAt), desc(platformAuditEvent.auditId))
            .limit(limit);
        return rows.map((row) => ({
            action: row.action,
            actor_id: row.actorId,
            actor_kind: row.actorKind,
            actor_ref: row.actorRef,
            app_id: row.appId,
            audit_id: row.auditId,
            details_json: row.detailsJson,
            outcome: row.outcome,
            project_id: row.projectId,
            recorded_at: row.recordedAt,
            subject_id: row.subjectId,
        }));
    };

    readonly readLegacyCredentialScope: PlatformProjectStore["readLegacyCredentialScope"] = async (
        credentialId,
        signal,
    ) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ createdAt: platformAppCredentialProject.createdAt })
            .from(platformAppCredentialProject)
            .where(
                and(
                    eq(platformAppCredentialProject.credentialId, credentialId),
                    eq(platformAppCredentialProject.projectId, this.#projectId),
                ),
            )
            .limit(1);
        return rows[0]?.createdAt ?? null;
    };
}
