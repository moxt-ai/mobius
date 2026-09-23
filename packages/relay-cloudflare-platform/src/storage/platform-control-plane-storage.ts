import { relayDrizzle } from "@moxt-ai/mobius-relay-core/database";
import { and, desc, eq } from "drizzle-orm";
import {
    type ActiveCountRow,
    ActiveCountRowSchema,
    type AppRow,
    AppRowSchema,
    type AuditRow,
    AuditRowSchema,
    type CredentialRevisionRow,
    CredentialRevisionRowSchema,
    type CredentialRow,
    CredentialRowSchema,
    type PlatformAppCredentialInsert,
    type PlatformAuditRecord,
    type PlatformProjectScopeRow,
    PlatformProjectScopeRowSchema,
    type ProjectIdRow,
    ProjectIdRowSchema,
    type ProjectRow,
    ProjectRowSchema,
    type RecordPresenceRow,
    RecordPresenceRowSchema,
    type TenantRow,
    TenantRowSchema,
} from "../entity/platform-records.ts";
import { platformAuditEvent, platformDashboardAuditEvent } from "../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord, decodeStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";
import { type PlatformDatabaseResolver, projectDatabase, projectSqlDatabase } from "./platform-database-resolver.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";

export class PlatformControlPlaneStorage {
    readonly #database: D1Database;
    readonly #databases: PlatformDatabaseResolver;

    constructor(database: D1Database, databases: PlatformDatabaseResolver) {
        this.#database = database;
        this.#databases = databases;
    }

    readonly createTenant = async (
        tenant: TenantRow,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            `INSERT INTO platform_tenants (
                               tenant_id, display_name, lifecycle, quotas_json, created_at, updated_at
                             ) VALUES (?, ?, 'active', ?, ?, ?) ON CONFLICT(tenant_id) DO NOTHING`,
                        )
                        .bind(
                            tenant.tenant_id,
                            tenant.display_name,
                            tenant.quotas_json,
                            tenant.created_at,
                            tenant.updated_at,
                        ),
                    this.dashboardAuditStatement(audit),
                ]),
            signal,
        );
        return results.every((result) => result.success);
    };

    readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<TenantRow | null> =>
        decodeOptionalStorageRecord(
            TenantRowSchema,
            await waitForD1(
                () =>
                    this.#database.prepare("SELECT * FROM platform_tenants WHERE tenant_id = ?").bind(tenantId).first(),
                signal,
            ),
        );

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<AppRow | null> =>
        decodeOptionalStorageRecord(
            AppRowSchema,
            await waitForD1(
                () => this.#database.prepare("SELECT * FROM platform_apps WHERE app_id = ?").bind(appId).first(),
                signal,
            ),
        );

    readonly updateApp = async (
        appId: string,
        displayName: string,
        updatedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            "UPDATE platform_apps SET display_name = ?, updated_at = ? WHERE app_id = ? AND lifecycle = 'active'",
                        )
                        .bind(displayName, updatedAt, appId),
                    this.dashboardAuditStatement(audit),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly deleteApp = async (
        appId: string,
        deletedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            `UPDATE platform_apps SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
                              WHERE app_id = ? AND lifecycle = 'active'`,
                        )
                        .bind(deletedAt, deletedAt, appId),
                    this.#database
                        .prepare(
                            `UPDATE platform_projects SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
                              WHERE app_id = ? AND lifecycle != 'deleted'`,
                        )
                        .bind(deletedAt, deletedAt, appId),
                    this.#database
                        .prepare(
                            "UPDATE platform_app_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE app_id = ?",
                        )
                        .bind(deletedAt, appId),
                    this.dashboardAuditStatement(audit),
                ]),
            signal,
        );
        return results[0]?.meta.changes === 1 && results[3]?.meta.changes === 1;
    };

    readonly countActiveApps = async (tenantId: string, signal: AbortSignal): Promise<number> => {
        const row: ActiveCountRow | null = decodeOptionalStorageRecord(
            ActiveCountRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            "SELECT COUNT(*) AS active_count FROM platform_apps WHERE tenant_id = ? AND lifecycle = 'active'",
                        )
                        .bind(tenantId)
                        .first(),
                signal,
            ),
        );
        return row?.active_count ?? -1;
    };

    readonly createApp = async (
        app: AppRow,
        credential: PlatformAppCredentialInsert,
        activeAppLimit: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{ readonly appCreated: boolean; readonly relatedRecordsCreated: boolean }> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            `INSERT INTO platform_apps (
                               app_id, tenant_id, display_name, lifecycle, default_credential_id,
                               created_at, updated_at
                             ) SELECT ?, ?, ?, 'active', ?, ?, ?
                               WHERE (SELECT COUNT(*) FROM platform_apps
                                       WHERE tenant_id = ? AND lifecycle = 'active') < ?`,
                        )
                        .bind(
                            app.app_id,
                            app.tenant_id,
                            app.display_name,
                            app.default_credential_id,
                            app.created_at,
                            app.updated_at,
                            app.tenant_id,
                            activeAppLimit,
                        ),
                    this.credentialInsertStatement(credential),
                    this.auditCreatedAppStatement(audit),
                ]),
            signal,
        );
        return {
            appCreated: results[0]?.meta.changes === 1,
            relatedRecordsCreated: results.slice(1).every((result) => result.meta.changes === 1),
        };
    };

    readonly readProjectByIdempotencyKey = async (
        appId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ProjectRow | null> =>
        decodeOptionalStorageRecord(
            ProjectRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare("SELECT * FROM platform_projects WHERE app_id = ? AND idempotency_key = ?")
                        .bind(appId, idempotencyKey)
                        .first(),
                signal,
            ),
        );

    readonly readActiveProjectScope = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<PlatformProjectScopeRow | null> =>
        decodeOptionalStorageRecord(
            PlatformProjectScopeRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT app_id, tenant_id, project_id, lifecycle
                               FROM platform_projects
                              WHERE project_id = ? AND lifecycle = 'active'`,
                        )
                        .bind(projectId)
                        .first(),
                signal,
            ),
        );

    readonly countActiveProjects = async (tenantId: string, signal: AbortSignal): Promise<number> => {
        const row: ActiveCountRow | null = decodeOptionalStorageRecord(
            ActiveCountRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            "SELECT COUNT(*) AS active_count FROM platform_projects WHERE tenant_id = ? AND lifecycle = 'active'",
                        )
                        .bind(tenantId)
                        .first(),
                signal,
            ),
        );
        return row?.active_count ?? -1;
    };

    readonly createProject = async (
        project: ProjectRow,
        activeProjectLimit: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{ readonly projectCreated: boolean; readonly auditRecorded: boolean }> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            `INSERT INTO platform_projects (
                                project_id, tenant_id, app_id, display_name, client_reference,
                                idempotency_key, request_digest, lifecycle, location_hint, created_at, updated_at
                              ) SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
                               WHERE (SELECT COUNT(*) FROM platform_projects
                                       WHERE tenant_id = ? AND lifecycle = 'active') < ?`,
                        )
                        .bind(
                            project.project_id,
                            project.tenant_id,
                            project.app_id,
                            project.display_name,
                            project.client_reference,
                            project.idempotency_key,
                            project.request_digest,
                            project.location_hint,
                            project.created_at,
                            project.updated_at,
                            project.tenant_id,
                            activeProjectLimit,
                        ),
                ]),
            signal,
        );
        return {
            projectCreated: results[0]?.meta.changes === 1,
            auditRecorded: results[0]?.meta.changes === 1 && (await this.recordAudit(audit, signal)),
        };
    };

    readonly listApps = async (tenantId: string, signal: AbortSignal): Promise<readonly AppRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        "SELECT * FROM platform_apps WHERE tenant_id = ? AND lifecycle = 'active' ORDER BY created_at, app_id",
                    )
                    .bind(tenantId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(AppRowSchema, rows.results);
    };

    readonly listProjects = async (appId: string, signal: AbortSignal): Promise<readonly ProjectRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare("SELECT * FROM platform_projects WHERE app_id = ? ORDER BY created_at, project_id")
                    .bind(appId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(ProjectRowSchema, rows.results);
    };

    readonly readTenantUsage = async (
        tenantId: string,
        signal: AbortSignal,
    ): Promise<{ readonly activeApps: number; readonly activeProjects: number }> => {
        const [apps, projects] = await waitForD1(
            () =>
                Promise.all([
                    this.#database
                        .prepare(
                            "SELECT COUNT(*) AS active_count FROM platform_apps WHERE tenant_id = ? AND lifecycle = 'active'",
                        )
                        .bind(tenantId)
                        .first(),
                    this.#database
                        .prepare(
                            "SELECT COUNT(*) AS active_count FROM platform_projects WHERE tenant_id = ? AND lifecycle = 'active'",
                        )
                        .bind(tenantId)
                        .first(),
                ]),
            signal,
        );
        return {
            activeApps: decodeStorageRecord(ActiveCountRowSchema, apps).active_count,
            activeProjects: decodeStorageRecord(ActiveCountRowSchema, projects).active_count,
        };
    };

    readonly listTenantAuditEvents = async (
        tenantId: string,
        projectId: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly AuditRow[]> => {
        if (projectId === null) {
            const rows = await waitForD1(
                () =>
                    platformDrizzle(this.#database)
                        .select()
                        .from(platformDashboardAuditEvent)
                        .where(
                            and(
                                eq(platformDashboardAuditEvent.tenantId, tenantId),
                                eq(platformDashboardAuditEvent.projectId, ""),
                            ),
                        )
                        .orderBy(
                            desc(platformDashboardAuditEvent.recordedAt),
                            desc(platformDashboardAuditEvent.auditId),
                        )
                        .limit(limit),
                signal,
            );
            return decodeStorageRecords(
                AuditRowSchema,
                rows.map((row) => ({
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
                    tenant_id: row.tenantId,
                })),
            );
        }
        const rows = await waitForD1(
            () =>
                relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal)
                    .select()
                    .from(platformAuditEvent)
                    .where(eq(platformAuditEvent.projectId, projectId))
                    .orderBy(desc(platformAuditEvent.recordedAt), desc(platformAuditEvent.auditId))
                    .limit(limit),
            signal,
        );
        return decodeStorageRecords(
            AuditRowSchema,
            rows.map((row) => ({
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
                tenant_id: tenantId,
            })),
        );
    };

    readonly issueAppCredential = async (
        credential: PlatformAppCredentialInsert,
        projectIds: readonly string[],
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        for (const projectId of projectIds) {
            await waitForD1(
                () =>
                    projectDatabase(this.#databases, projectId)
                        .prepare(
                            `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                         VALUES (?, ?, ?)`,
                        )
                        .bind(credential.credentialId, projectId, credential.issuedAt)
                        .run(),
                signal,
            );
        }
        const statements = [this.credentialInsertStatement(credential), this.dashboardAuditStatement(audit)];
        const results = await waitForD1(() => this.#database.batch(statements), signal);
        return results.every((result) => result.meta.changes === 1);
    };

    readonly listAppCredentials = async (appId: string, signal: AbortSignal): Promise<readonly CredentialRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT credentials.*, apps.tenant_id,
                                     apps.lifecycle AS app_lifecycle,
                                     tenants.lifecycle AS tenant_lifecycle
                           FROM platform_app_credentials AS credentials
                           JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                           JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
                          WHERE credentials.app_id = ?
                          ORDER BY credentials.issued_at DESC, credentials.credential_id DESC`,
                    )
                    .bind(appId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(CredentialRowSchema, rows.results);
    };

    readonly listCredentialProjectIds = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const credential = await this.readCredentialById(credentialId, signal);
        if (credential === null) {
            return [];
        }
        const projects = await this.listProjects(credential.app_id, signal);
        const scoped: string[] = [];
        for (const project of projects) {
            if (await this.credentialHasProject(credentialId, project.project_id, signal)) {
                scoped.push(project.project_id);
            }
        }
        return scoped.sort();
    };

    readonly rotateAppCredential = async (
        credential: PlatformAppCredentialInsert,
        sourceCredentialId: string,
        overlapEndsAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{
        readonly auditRecorded: boolean;
        readonly credentialInserted: boolean;
        readonly sourceRotated: boolean;
    }> => {
        for (const projectId of await this.listCredentialProjectIds(sourceCredentialId, signal)) {
            await waitForD1(
                () =>
                    projectDatabase(this.#databases, projectId)
                        .prepare(
                            `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                 SELECT ?, project_id, ? FROM platform_app_credential_projects WHERE credential_id = ? AND project_id = ?`,
                        )
                        .bind(credential.credentialId, credential.issuedAt, sourceCredentialId, projectId)
                        .run(),
                signal,
            );
        }
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.credentialInsertStatement(credential),
                    this.#database
                        .prepare(
                            `UPDATE platform_app_credentials
                                SET replaced_by_credential_id = ?, overlap_ends_at = ?
                              WHERE credential_id = ? AND revoked_at IS NULL AND replaced_by_credential_id IS NULL`,
                        )
                        .bind(credential.credentialId, overlapEndsAt, sourceCredentialId),
                    this.dashboardAuditStatement(audit),
                ]),
            signal,
        );
        return {
            credentialInserted: results[0]?.meta.changes === 1,
            sourceRotated: results[1]?.meta.changes === 1,
            auditRecorded: results[2]?.meta.changes === 1,
        };
    };

    readonly revokeAppCredential = async (
        credentialId: string,
        revokedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{ readonly auditRecorded: boolean; readonly credentialRevoked: boolean }> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            "UPDATE platform_app_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
                        )
                        .bind(revokedAt, credentialId),
                    this.dashboardAuditStatement(audit),
                ]),
            signal,
        );
        return {
            credentialRevoked: results[0]?.meta.changes === 1,
            auditRecorded: results[1]?.meta.changes === 1,
        };
    };

    readonly credentialHasProject = async (
        credentialId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const row = await waitForD1(
            () =>
                projectDatabase(this.#databases, projectId)
                    .prepare(
                        "SELECT 1 AS present FROM platform_app_credential_projects WHERE credential_id = ? AND project_id = ?",
                    )
                    .bind(credentialId, projectId)
                    .first(),
            signal,
        );
        const presence: RecordPresenceRow | null =
            row === null ? null : decodeStorageRecord(RecordPresenceRowSchema, row);
        return presence?.present === 1;
    };

    readonly touchCredential = async (credentialId: string, now: number, signal: AbortSignal): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `UPDATE platform_app_credentials SET last_used_at = ?
                          WHERE credential_id = ? AND revoked_at IS NULL
                            AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`,
                    )
                    .bind(now, credentialId, now)
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };

    readonly readCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow | null> =>
        decodeOptionalStorageRecord(
            CredentialRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT credentials.*, apps.tenant_id,
                                     apps.lifecycle AS app_lifecycle,
                                     tenants.lifecycle AS tenant_lifecycle
                               FROM platform_app_credentials AS credentials
                               JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                               JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
                              WHERE credentials.public_credential_id = ?`,
                        )
                        .bind(publicCredentialId)
                        .first(),
                signal,
            ),
        );

    readonly readCredentialById = async (credentialId: string, signal: AbortSignal): Promise<CredentialRow | null> =>
        decodeOptionalStorageRecord(
            CredentialRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT credentials.*, apps.tenant_id,
                                    apps.lifecycle AS app_lifecycle,
                                    tenants.lifecycle AS tenant_lifecycle
                               FROM platform_app_credentials AS credentials
                               JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                               JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
                              WHERE credentials.credential_id = ?`,
                        )
                        .bind(credentialId)
                        .first(),
                signal,
            ),
        );

    readonly listActiveProjectIds = async (appId: string, signal: AbortSignal): Promise<readonly string[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare("SELECT project_id FROM platform_projects WHERE app_id = ? AND lifecycle = 'active'")
                    .bind(appId)
                    .all(),
            signal,
        );
        const projects: readonly ProjectIdRow[] = decodeStorageRecords(ProjectIdRowSchema, rows.results);
        return projects.map((project) => project.project_id);
    };

    readonly listScopedActiveProjectIds = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const projectIds = await this.listCredentialProjectIds(credentialId, signal);
        const rows = await waitForD1(
            () =>
                Promise.all(
                    projectIds.map((projectId) =>
                        projectDatabase(this.#databases, projectId)
                            .prepare(
                                `SELECT projects.project_id
                           FROM platform_app_credential_projects AS scopes
                           JOIN platform_project_authorizations AS projects ON projects.project_id = scopes.project_id
                          WHERE scopes.credential_id = ? AND projects.project_id = ? AND projects.lifecycle = 'active'
                            AND NOT EXISTS (SELECT 1 FROM platform_project_app_revocations WHERE app_id = projects.app_id)`,
                            )
                            .bind(credentialId, projectId)
                            .all(),
                    ),
                ),
            signal,
        );
        const projects: readonly ProjectIdRow[] = rows.flatMap((result) =>
            decodeStorageRecords(ProjectIdRowSchema, result.results),
        );
        return projects.map((project) => project.project_id);
    };

    readonly nextCredentialRevision = async (appId: string, signal: AbortSignal): Promise<number | null> => {
        const row: CredentialRevisionRow | null = decodeOptionalStorageRecord(
            CredentialRevisionRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM platform_app_credentials WHERE app_id = ?",
                        )
                        .bind(appId)
                        .first(),
                signal,
            ),
        );
        return row?.revision ?? null;
    };

    readonly projectBelongsToApp = async (projectId: string, appId: string, signal: AbortSignal): Promise<boolean> => {
        const row = await waitForD1(
            () =>
                this.#database
                    .prepare("SELECT 1 AS present FROM platform_projects WHERE project_id = ? AND app_id = ?")
                    .bind(projectId, appId)
                    .first(),
            signal,
        );
        const presence: RecordPresenceRow | null =
            row === null ? null : decodeStorageRecord(RecordPresenceRowSchema, row);
        return presence?.present === 1;
    };

    readonly recordAudit = async (audit: PlatformAuditRecord, signal: AbortSignal): Promise<boolean> => {
        if (audit.projectId === "") {
            const result = await waitForD1(() => this.dashboardAuditStatement(audit).run(), signal);
            return result.success;
        }
        await waitForD1(
            () =>
                relayDrizzle(projectSqlDatabase(this.#databases, audit.projectId), signal)
                    .insert(platformAuditEvent)
                    .values({
                        auditId: audit.action === "project.created" ? `pae_created_${audit.projectId}` : audit.auditId,
                        appId: audit.appId,
                        projectId: audit.projectId,
                        actorKind: audit.actorKind,
                        actorId: audit.actorId,
                        actorRef: audit.actorRef,
                        action: audit.action,
                        subjectId: audit.subjectId,
                        outcome: audit.outcome === "succeeded" ? "succeeded" : "denied",
                        detailsJson: audit.detailsJson,
                        recordedAt: audit.recordedAt,
                    })
                    .onConflictDoNothing({ target: platformAuditEvent.auditId }),
            signal,
        );
        return true;
    };

    private readonly credentialInsertStatement = (credential: PlatformAppCredentialInsert): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_app_credentials (
                   credential_id, public_credential_id, app_id, secret_digest, permissions_json,
                   all_projects, revision, issued_at, last_used_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM platform_apps WHERE app_id = ?)`,
            )
            .bind(
                credential.credentialId,
                credential.publicCredentialId,
                credential.appId,
                credential.secretDigest,
                credential.permissionsJson,
                credential.allProjects ? 1 : 0,
                credential.revision,
                credential.issuedAt,
                credential.issuedAt,
                credential.appId,
            );

    private readonly auditCreatedAppStatement = (audit: PlatformAuditRecord): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_dashboard_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM platform_apps WHERE app_id = ?)`,
            )
            .bind(
                audit.auditId,
                audit.tenantId,
                audit.appId,
                audit.projectId,
                audit.actorKind,
                audit.actorId,
                audit.actorRef,
                audit.action,
                audit.subjectId,
                audit.outcome,
                audit.detailsJson,
                audit.recordedAt,
                audit.appId,
            );

    private readonly dashboardAuditStatement = (audit: PlatformAuditRecord): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_dashboard_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(audit_id) DO NOTHING`,
            )
            .bind(
                audit.action === "project.created" ? `pae_created_${audit.projectId}` : audit.auditId,
                audit.tenantId,
                audit.appId,
                audit.projectId,
                audit.actorKind,
                audit.actorId,
                audit.actorRef,
                audit.action,
                audit.subjectId,
                audit.outcome,
                audit.detailsJson,
                audit.recordedAt,
            );
}
