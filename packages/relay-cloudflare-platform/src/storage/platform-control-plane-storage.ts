import {
    type ActiveCountRow,
    ActiveCountRowSchema,
    type AppIdRow,
    AppIdRowSchema,
    type AppRow,
    AppRowSchema,
    type AuditRow,
    AuditRowSchema,
    type CredentialRevisionRow,
    CredentialRevisionRowSchema,
    type CredentialRow,
    CredentialRowSchema,
    type MembershipRow,
    MembershipRowSchema,
    type PlatformAppCredentialInsert,
    type PlatformAuditRecord,
    type PlatformDeveloperMembershipInsert,
    type PlatformProjectScopeRow,
    PlatformProjectScopeRowSchema,
    type ProjectIdRow,
    ProjectIdRowSchema,
    type ProjectRow,
    ProjectRowSchema,
    type ProjectStoragePlacementRow,
    ProjectStoragePlacementRowSchema,
    type RecordPresenceRow,
    RecordPresenceRowSchema,
    type TenantRow,
    TenantRowSchema,
} from "../entity/platform-records.ts";
import { decodeOptionalStorageRecord, decodeStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";

async function waitForD1<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const result = await operation();
    signal.throwIfAborted();
    return result;
}

export class PlatformControlPlaneStorage {
    readonly #database: D1Database;
    readonly #projectDatabases: readonly D1Database[];

    constructor(database: D1Database, projectDatabases: readonly D1Database[]) {
        this.#database = database;
        this.#projectDatabases = projectDatabases;
    }

    readonly createTenant = async (
        tenant: TenantRow,
        membership: PlatformDeveloperMembershipInsert,
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
                             ) VALUES (?, ?, 'active', ?, ?, ?)`,
                        )
                        .bind(
                            tenant.tenant_id,
                            tenant.display_name,
                            tenant.quotas_json,
                            tenant.created_at,
                            tenant.updated_at,
                        ),
                    this.#database
                        .prepare(
                            `INSERT INTO platform_developer_memberships (
                               membership_id, provider_id, issuer, subject, tenant_id, role, created_at
                             ) VALUES (?, ?, ?, ?, ?, 'owner', ?)`,
                        )
                        .bind(
                            membership.membershipId,
                            membership.providerId,
                            membership.issuer,
                            membership.subject,
                            membership.tenantId,
                            membership.createdAt,
                        ),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readDeveloperMembership = async (
        providerId: string,
        issuer: string,
        subject: string,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<MembershipRow | null> =>
        decodeOptionalStorageRecord(
            MembershipRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT memberships.membership_id, memberships.tenant_id, memberships.role
                               FROM platform_developer_memberships AS memberships
                               JOIN platform_tenants AS tenants ON tenants.tenant_id = memberships.tenant_id
                              WHERE memberships.provider_id = ? AND memberships.issuer = ? AND memberships.subject = ?
                                AND memberships.tenant_id = ? AND memberships.revoked_at IS NULL
                                AND tenants.lifecycle = 'active'`,
                        )
                        .bind(providerId, issuer, subject, tenantId)
                        .first(),
                signal,
            ),
        );

    readonly listDeveloperTenants = async (
        providerId: string,
        issuer: string,
        subject: string,
        signal: AbortSignal,
    ): Promise<readonly TenantRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT tenants.* FROM platform_tenants AS tenants
                           JOIN platform_developer_memberships AS memberships USING (tenant_id)
                          WHERE memberships.provider_id = ? AND memberships.issuer = ? AND memberships.subject = ?
                            AND memberships.revoked_at IS NULL AND tenants.lifecycle = 'active'
                          ORDER BY tenants.created_at, tenants.tenant_id`,
                    )
                    .bind(providerId, issuer, subject)
                    .all(),
            signal,
        );
        return decodeStorageRecords(TenantRowSchema, rows.results);
    };

    readonly readActiveProjectAppId = async (
        tenantId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        const row: AppIdRow | null = decodeOptionalStorageRecord(
            AppIdRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT app_id FROM platform_projects
                              WHERE tenant_id = ? AND project_id = ? AND lifecycle = 'active'`,
                        )
                        .bind(tenantId, projectId)
                        .first(),
                signal,
            ),
        );
        return row?.app_id ?? null;
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

    readonly updateTenant = async (
        tenantId: string,
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
                            "UPDATE platform_tenants SET display_name = ?, updated_at = ? WHERE tenant_id = ? AND lifecycle = 'active'",
                        )
                        .bind(displayName, updatedAt, tenantId),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly deleteTenant = async (
        tenantId: string,
        deletedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.#database
                        .prepare(
                            `UPDATE platform_tenants SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
                              WHERE tenant_id = ? AND lifecycle = 'active'`,
                        )
                        .bind(deletedAt, deletedAt, tenantId),
                    this.#database
                        .prepare(
                            `UPDATE platform_apps SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
                              WHERE tenant_id = ? AND lifecycle != 'deleted'`,
                        )
                        .bind(deletedAt, deletedAt, tenantId),
                    this.#database
                        .prepare(
                            `UPDATE platform_projects SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
                              WHERE tenant_id = ? AND lifecycle != 'deleted'`,
                        )
                        .bind(deletedAt, deletedAt, tenantId),
                    this.#database
                        .prepare(
                            `UPDATE platform_app_credentials SET revoked_at = COALESCE(revoked_at, ?)
                              WHERE app_id IN (SELECT app_id FROM platform_apps WHERE tenant_id = ?)`,
                        )
                        .bind(deletedAt, tenantId),
                    this.#database
                        .prepare(
                            "UPDATE conversation_access_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE tenant_id = ?",
                        )
                        .bind(deletedAt, tenantId),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return results[0]?.meta.changes === 1 && results[5]?.meta.changes === 1;
    };

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
                    this.auditStatement(audit),
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
                    this.#database
                        .prepare(
                            "UPDATE conversation_access_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE app_id = ?",
                        )
                        .bind(deletedAt, appId),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return results[0]?.meta.changes === 1 && results[4]?.meta.changes === 1;
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
                               app_id, tenant_id, display_name, lifecycle, default_credential_id, created_at, updated_at
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
                        .prepare(`SELECT projects.*, placement.d1_shard_id, placement.r2_bucket_id,
                                         placement.placement_revision
                                    FROM platform_projects AS projects
                                    JOIN platform_project_storage_placements AS placement USING (project_id)
                                   WHERE app_id = ? AND idempotency_key = ?`)
                        .bind(appId, idempotencyKey)
                        .first(),
                signal,
            ),
        );

    readonly readProjectStoragePlacement = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<ProjectStoragePlacementRow | null> =>
        decodeOptionalStorageRecord(
            ProjectStoragePlacementRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT tenant_id, project_id, d1_shard_id, r2_bucket_id, placement_revision
                               FROM platform_projects
                               JOIN platform_project_storage_placements USING (project_id)
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
                                idempotency_key, request_digest, lifecycle, created_at, updated_at
                              ) SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
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
                            project.created_at,
                            project.updated_at,
                            project.tenant_id,
                            activeProjectLimit,
                        ),
                    this.#database
                        .prepare(`INSERT INTO platform_project_storage_placements (
                                      project_id, d1_shard_id, r2_bucket_id, placement_revision
                                  ) SELECT project_id, ?, ?, ? FROM platform_projects WHERE project_id = ?`)
                        .bind(
                            project.d1_shard_id,
                            project.r2_bucket_id,
                            project.placement_revision,
                            project.project_id,
                        ),
                    this.auditCreatedProjectStatement(audit),
                ]),
            signal,
        );
        return {
            projectCreated: results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1,
            auditRecorded: results[2]?.meta.changes === 1,
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
                    .prepare(`SELECT projects.*, placement.d1_shard_id, placement.r2_bucket_id,
                                     placement.placement_revision
                                FROM platform_projects AS projects
                                JOIN platform_project_storage_placements AS placement USING (project_id)
                               WHERE app_id = ? ORDER BY created_at, project_id`)
                    .bind(appId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(ProjectRowSchema, rows.results);
    };

    readonly readTenantUsage = async (
        tenantId: string,
        signal: AbortSignal,
    ): Promise<{
        readonly activeApps: number;
        readonly activeProjects: number;
        readonly activeSessions: number;
    }> => {
        const ownedProjects = await waitForD1(
            () =>
                this.#database
                    .prepare("SELECT project_id FROM platform_projects WHERE tenant_id = ?")
                    .bind(tenantId)
                    .all(),
            signal,
        );
        const projectIds = decodeStorageRecords(ProjectIdRowSchema, ownedProjects.results).map((row) => row.project_id);
        const [apps, projects, ...sessions] = await waitForD1(
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
                    ...this.#projectDatabases.map(
                        async (database) =>
                            await database
                                .prepare(`SELECT COUNT(*) AS active_count FROM session_quota_reservations
                                       WHERE project_id IN (SELECT value FROM json_each(?))`)
                                .bind(JSON.stringify(projectIds))
                                .first(),
                    ),
                ]),
            signal,
        );
        const appCount: ActiveCountRow = decodeStorageRecord(ActiveCountRowSchema, apps);
        const projectCount: ActiveCountRow = decodeStorageRecord(ActiveCountRowSchema, projects);
        const sessionCount = sessions.reduce(
            (total, row) => total + decodeStorageRecord(ActiveCountRowSchema, row).active_count,
            0,
        );
        return {
            activeApps: appCount.active_count,
            activeProjects: projectCount.active_count,
            activeSessions: sessionCount,
        };
    };

    readonly listTenantAuditEvents = async (
        tenantId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly AuditRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT * FROM platform_audit_events
                          WHERE tenant_id = ?
                          ORDER BY recorded_at DESC, audit_id DESC
                          LIMIT ?`,
                    )
                    .bind(tenantId, limit)
                    .all(),
            signal,
        );
        return decodeStorageRecords(AuditRowSchema, rows.results);
    };

    readonly issueAppCredential = async (
        credential: PlatformAppCredentialInsert,
        projectIds: readonly string[],
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const statements = [this.credentialInsertStatement(credential)];
        for (const projectId of projectIds) {
            statements.push(
                this.#database
                    .prepare(
                        `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                         VALUES (?, ?, ?)`,
                    )
                    .bind(credential.credentialId, projectId, credential.issuedAt),
            );
        }
        statements.push(this.auditStatement(audit));
        const results = await waitForD1(() => this.#database.batch(statements), signal);
        return results.every((result) => result.meta.changes === 1);
    };

    readonly listAppCredentials = async (appId: string, signal: AbortSignal): Promise<readonly CredentialRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT credentials.*, apps.tenant_id,
                                apps.lifecycle AS app_lifecycle, tenants.lifecycle AS tenant_lifecycle
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
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        "SELECT project_id FROM platform_app_credential_projects WHERE credential_id = ? ORDER BY project_id",
                    )
                    .bind(credentialId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(ProjectIdRowSchema, rows.results).map((row) => row.project_id);
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
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.credentialInsertStatement(credential),
                    this.#database
                        .prepare(
                            `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                             SELECT ?, project_id, ? FROM platform_app_credential_projects WHERE credential_id = ?`,
                        )
                        .bind(credential.credentialId, credential.issuedAt, sourceCredentialId),
                    this.#database
                        .prepare(
                            `UPDATE platform_app_credentials
                                SET replaced_by_credential_id = ?, overlap_ends_at = ?
                              WHERE credential_id = ? AND revoked_at IS NULL AND replaced_by_credential_id IS NULL`,
                        )
                        .bind(credential.credentialId, overlapEndsAt, sourceCredentialId),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return {
            credentialInserted: results[0]?.meta.changes === 1,
            sourceRotated: results[2]?.meta.changes === 1,
            auditRecorded: results[3]?.meta.changes === 1,
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
                    this.#database
                        .prepare(
                            "UPDATE conversation_access_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE parent_credential_id = ?",
                        )
                        .bind(revokedAt, credentialId),
                    this.auditStatement(audit),
                ]),
            signal,
        );
        return {
            credentialRevoked: results[0]?.meta.changes === 1,
            auditRecorded: results[2]?.meta.changes === 1,
        };
    };

    readonly readProjectScope = async (
        projectId: string,
        appId: string,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<PlatformProjectScopeRow | null> =>
        decodeOptionalStorageRecord(
            PlatformProjectScopeRowSchema,
            await waitForD1(
                () =>
                    this.#database
                        .prepare(
                            `SELECT project_id, tenant_id, app_id, lifecycle
                               FROM platform_projects
                              WHERE project_id = ? AND app_id = ? AND tenant_id = ?`,
                        )
                        .bind(projectId, appId, tenantId)
                        .first(),
                signal,
            ),
        );

    readonly credentialHasProject = async (
        credentialId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const row = await waitForD1(
            () =>
                this.#database
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
                                    apps.lifecycle AS app_lifecycle, tenants.lifecycle AS tenant_lifecycle
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
                                    apps.lifecycle AS app_lifecycle, tenants.lifecycle AS tenant_lifecycle
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
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT projects.project_id
                           FROM platform_app_credential_projects AS scopes
                           JOIN platform_projects AS projects ON projects.project_id = scopes.project_id
                          WHERE scopes.credential_id = ? AND projects.lifecycle = 'active'`,
                    )
                    .bind(credentialId)
                    .all(),
            signal,
        );
        const projects: readonly ProjectIdRow[] = decodeStorageRecords(ProjectIdRowSchema, rows.results);
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
        const result = await waitForD1(() => this.auditStatement(audit).run(), signal);
        return result.meta.changes === 1;
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
                `INSERT INTO platform_audit_events (
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

    private readonly auditCreatedProjectStatement = (audit: PlatformAuditRecord): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM platform_projects WHERE project_id = ?)`,
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
                audit.projectId,
            );

    private readonly auditStatement = (audit: PlatformAuditRecord): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            );
}
