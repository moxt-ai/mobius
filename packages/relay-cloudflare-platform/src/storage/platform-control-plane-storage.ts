import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
    type AppRow,
    AppRowSchema,
    type AuditRow,
    AuditRowSchema,
    type CredentialRow,
    CredentialRowSchema,
    type PlatformAppCredentialInsert,
    type PlatformAuditRecord,
    type PlatformProjectScopeRow,
    PlatformProjectScopeRowSchema,
    type ProjectRow,
    ProjectRowSchema,
    type RecordPresenceRow,
    RecordPresenceRowSchema,
    type TenantRow,
    TenantRowSchema,
} from "../entity/platform-records.ts";
import type { PlatformProjectStores } from "../infra/platform-project-store.ts";
import {
    platformApp,
    platformAppCredential,
    platformAppCredentialScope,
    platformDashboardAuditEvent,
    platformProject,
    platformTenant,
} from "../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord, decodeStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";
import { appActive, projectServed } from "./platform-lifecycle.ts";

export class PlatformControlPlaneStorage {
    readonly #database: D1Database;
    readonly #projects: Pick<PlatformProjectStores, "forProject">;

    constructor(database: D1Database, projects: Pick<PlatformProjectStores, "forProject">) {
        this.#database = database;
        this.#projects = projects;
    }

    readonly createTenant = async (
        tenant: TenantRow,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.statement(
                        platformDrizzle(this.#database)
                            .insert(platformTenant)
                            .values({
                                tenantId: tenant.tenant_id,
                                displayName: tenant.display_name,
                                quotasJson: tenant.quotas_json,
                                createdAt: tenant.created_at,
                                updatedAt: tenant.updated_at,
                            })
                            .onConflictDoNothing(),
                    ),
                    this.auditOfPreviousChange(audit),
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
                    this.statement(
                        platformDrizzle(this.#database)
                            .update(platformApp)
                            .set({ displayName, updatedAt })
                            .where(and(eq(platformApp.appId, appId), appActive)),
                    ),
                    this.auditOfPreviousChange(audit),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    /**
     * The single writer that ends an App. One batch records the App, each of its Projects and each of its
     * AppCredentials as ended, so readers consult only the entity they read (see platform-lifecycle.ts).
     */
    readonly deleteApp = async (
        appId: string,
        deletedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = platformDrizzle(this.#database);
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.statement(
                        database
                            .update(platformApp)
                            .set({ lifecycle: "deleted", deletedAt, updatedAt: deletedAt })
                            .where(and(eq(platformApp.appId, appId), appActive)),
                    ),
                    this.auditOfPreviousChange(audit),
                    this.statement(
                        database
                            .update(platformProject)
                            .set({ lifecycle: "deleted", deletedAt, updatedAt: deletedAt })
                            .where(and(eq(platformProject.appId, appId), projectServed)),
                    ),
                    this.statement(
                        database
                            .update(platformAppCredential)
                            .set({ revokedAt: deletedAt })
                            .where(
                                and(eq(platformAppCredential.appId, appId), isNull(platformAppCredential.revokedAt)),
                            ),
                    ),
                ]),
            signal,
        );
        return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
    };

    readonly countActiveApps = async (tenantId: string, signal: AbortSignal): Promise<number> =>
        await waitForD1(async () => await this.activeAppCount(tenantId), signal);

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
                    this.statement(this.appInsert(app, activeAppLimit)),
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
                        .prepare(
                            `SELECT projects.*, apps.tenant_id
                               FROM platform_projects AS projects JOIN platform_apps AS apps ON apps.app_id = projects.app_id
                              WHERE projects.app_id = ? AND projects.idempotency_key = ?`,
                        )
                        .bind(appId, idempotencyKey)
                        .first(),
                signal,
            ),
        );

    readonly readActiveProjectScope = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<PlatformProjectScopeRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({
                        app_id: platformProject.appId,
                        tenant_id: platformApp.tenantId,
                        project_id: platformProject.projectId,
                        lifecycle: platformProject.lifecycle,
                    })
                    .from(platformProject)
                    .innerJoin(platformApp, eq(platformApp.appId, platformProject.appId))
                    .where(and(eq(platformProject.projectId, projectId), projectServed))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(PlatformProjectScopeRowSchema, rows[0] ?? null);
    };

    readonly countActiveProjects = async (tenantId: string, signal: AbortSignal): Promise<number> =>
        await waitForD1(async () => await this.servedProjectCount(tenantId), signal);

    readonly createProject = async (
        project: ProjectRow,
        activeProjectLimit: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{ readonly projectCreated: boolean; readonly auditRecorded: boolean }> => {
        const results = await waitForD1(
            () => this.#database.batch([this.statement(this.projectInsert(project, activeProjectLimit))]),
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
                this.statement(
                    platformDrizzle(this.#database)
                        .select()
                        .from(platformApp)
                        .where(and(eq(platformApp.tenantId, tenantId), appActive))
                        .orderBy(asc(platformApp.createdAt), asc(platformApp.appId)),
                ).all(),
            signal,
        );
        return decodeStorageRecords(AppRowSchema, rows.results);
    };

    readonly listProjects = async (appId: string, signal: AbortSignal): Promise<readonly ProjectRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT projects.*, apps.tenant_id
                           FROM platform_projects AS projects JOIN platform_apps AS apps ON apps.app_id = projects.app_id
                          WHERE projects.app_id = ?
                          ORDER BY projects.created_at, projects.project_id`,
                    )
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
        const [activeApps, activeProjects] = await waitForD1(
            () => Promise.all([this.activeAppCount(tenantId), this.servedProjectCount(tenantId)]),
            signal,
        );
        return { activeApps, activeProjects };
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
        const rows = await this.#projects.forProject(projectId).listAuditEvents(limit, signal);
        return decodeStorageRecords(
            AuditRowSchema,
            rows.map((row) => ({ ...row, tenant_id: tenantId })),
        );
    };

    readonly issueAppCredential = async (
        credential: PlatformAppCredentialInsert,
        projectIds: readonly string[],
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const scope = projectIds.map((projectId) =>
            this.statement(this.scopeInsert(credential.credentialId, projectId, credential.issuedAt)),
        );
        const statements = [this.credentialInsertStatement(credential), this.auditOfPreviousChange(audit), ...scope];
        const results = await waitForD1(() => this.#database.batch(statements), signal);
        return results.every((result) => result.meta.changes === 1);
    };

    readonly listAppCredentials = async (appId: string, signal: AbortSignal): Promise<readonly CredentialRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .prepare(
                        `SELECT credentials.*, apps.tenant_id
                           FROM platform_app_credentials AS credentials
                           JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                          WHERE credentials.app_id = ?
                          ORDER BY credentials.issued_at DESC, credentials.credential_id DESC`,
                    )
                    .bind(appId)
                    .all(),
            signal,
        );
        return decodeStorageRecords(CredentialRowSchema, rows.results);
    };

    /**
     * The Projects a credential without all-Project access may use. Credentials issued before D1 owned this scope
     * kept it only in Project storage. A scoped credential always names a Project, so an empty D1 scope means it
     * was not copied yet; this complete read copies it, and D1 answers from then on.
     */
    readonly credentialProjectIds = async (
        credential: Pick<CredentialRow, "all_projects" | "app_id" | "credential_id">,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        if (credential.all_projects === 1) {
            return [];
        }
        const scope = await this.copiedScope(credential.credential_id, signal);
        if (scope.length > 0) {
            return scope;
        }
        const copied: { readonly projectId: string; readonly createdAt: number }[] = [];
        for (const project of await this.listProjects(credential.app_id, signal)) {
            const createdAt = await this.projectStorageScope(credential.credential_id, project.project_id, signal);
            if (createdAt !== null) {
                copied.push({ projectId: project.project_id, createdAt });
            }
        }
        if (copied.length > 0) {
            const database = platformDrizzle(this.#database);
            await waitForD1(
                () =>
                    this.#database.batch(
                        copied.map((row) =>
                            this.statement(
                                database
                                    .insert(platformAppCredentialScope)
                                    .values({ credentialId: credential.credential_id, ...row })
                                    .onConflictDoNothing(),
                            ),
                        ),
                    ),
                signal,
            );
        }
        return copied.map((row) => row.projectId).sort();
    };

    /**
     * The candidates a scoped credential may use. Until its scope is copied to D1, only the candidates' Project
     * storage is asked, so a request never depends on Projects it does not name.
     */
    readonly scopedProjects = async (
        credentialId: string,
        candidates: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const scope = await this.copiedScope(credentialId, signal);
        if (scope.length > 0) {
            return candidates.filter((projectId) => scope.includes(projectId));
        }
        const scoped: string[] = [];
        for (const projectId of candidates) {
            if ((await this.projectStorageScope(credentialId, projectId, signal)) !== null) {
                scoped.push(projectId);
            }
        }
        return scoped;
    };

    private readonly copiedScope = async (credentialId: string, signal: AbortSignal): Promise<readonly string[]> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ projectId: platformAppCredentialScope.projectId })
                    .from(platformAppCredentialScope)
                    .where(eq(platformAppCredentialScope.credentialId, credentialId))
                    .orderBy(asc(platformAppCredentialScope.projectId)),
            signal,
        );
        return rows.map((row) => row.projectId);
    };

    readonly rotateAppCredential = async (
        credential: PlatformAppCredentialInsert,
        sourceCredentialId: string,
        projectIds: readonly string[],
        overlapEndsAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{
        readonly auditRecorded: boolean;
        readonly credentialInserted: boolean;
        readonly sourceRotated: boolean;
    }> => {
        const database = platformDrizzle(this.#database);
        // A zero-row update does not abort a D1 batch. Gate every insert on this
        // attempt's replacement ID within the same transaction.
        const results = await waitForD1(
            () =>
                database.batch([
                    database
                        .update(platformAppCredential)
                        .set({ replacedByCredentialId: credential.credentialId, overlapEndsAt })
                        .where(
                            and(
                                eq(platformAppCredential.credentialId, sourceCredentialId),
                                isNull(platformAppCredential.revokedAt),
                                isNull(platformAppCredential.replacedByCredentialId),
                            ),
                        ),
                    database.insert(platformAppCredential).select(
                        database
                            .select({
                                credentialId: sql<string>`${credential.credentialId}`.as("credentialId"),
                                publicCredentialId: sql<string>`${credential.publicCredentialId}`.as(
                                    "publicCredentialId",
                                ),
                                appId: sql<string>`${credential.appId}`.as("appId"),
                                secretDigest: sql<string>`${credential.secretDigest}`.as("secretDigest"),
                                permissionsJson: sql<string>`${credential.permissionsJson}`.as("permissionsJson"),
                                allProjects: sql<number>`${credential.allProjects ? 1 : 0}`.as("allProjects"),
                                issuedAt: sql<number>`${credential.issuedAt}`.as("issuedAt"),
                                overlapEndsAt: sql<null>`NULL`.as("overlapEndsAt"),
                                replacedByCredentialId: sql<null>`NULL`.as("replacedByCredentialId"),
                                revokedAt: sql<null>`NULL`.as("revokedAt"),
                            })
                            .from(platformAppCredential)
                            .where(
                                and(
                                    eq(platformAppCredential.credentialId, sourceCredentialId),
                                    eq(platformAppCredential.replacedByCredentialId, credential.credentialId),
                                ),
                            ),
                    ),
                    database.insert(platformDashboardAuditEvent).select(
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
                            .from(platformAppCredential)
                            .where(eq(platformAppCredential.credentialId, credential.credentialId)),
                    ),
                    ...projectIds.map((projectId) =>
                        this.scopeInsert(credential.credentialId, projectId, credential.issuedAt),
                    ),
                ]),
            signal,
        );
        return {
            sourceRotated: results[0].meta.changes === 1,
            credentialInserted: results[1].meta.changes === 1,
            auditRecorded: results[2].meta.changes === 1,
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
                    this.auditOfPreviousChange(audit),
                ]),
            signal,
        );
        return {
            credentialRevoked: results[0]?.meta.changes === 1,
            auditRecorded: results[1]?.meta.changes === 1,
        };
    };

    /** Reads the scope Workers kept in Project storage before D1 owned it. */
    private readonly projectStorageScope = async (
        credentialId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<number | null> =>
        await this.#projects.forProject(projectId).readLegacyCredentialScope(credentialId, signal);

    /** A scope row exists only when its credential was inserted in the same batch. */
    private readonly scopeInsert = (credentialId: string, projectId: string, createdAt: number) => {
        const database = platformDrizzle(this.#database);
        return database.insert(platformAppCredentialScope).select(
            database
                .select({
                    credentialId: sql<string>`${credentialId}`.as("credentialId"),
                    projectId: sql<string>`${projectId}`.as("projectId"),
                    createdAt: sql<number>`${createdAt}`.as("createdAt"),
                })
                .from(platformAppCredential)
                .where(eq(platformAppCredential.credentialId, credentialId)),
        );
    };

    private readonly statement = (query: { readonly toSQL: () => { sql: string; params: unknown[] } }) => {
        const { sql: text, params } = query.toSQL();
        return this.#database.prepare(text).bind(...params);
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
                            `SELECT credentials.*, apps.tenant_id
                               FROM platform_app_credentials AS credentials
                               JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
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
                            `SELECT credentials.*, apps.tenant_id
                               FROM platform_app_credentials AS credentials
                               JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
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
                platformDrizzle(this.#database)
                    .select({ projectId: platformProject.projectId })
                    .from(platformProject)
                    .where(and(eq(platformProject.appId, appId), projectServed)),
            signal,
        );
        return rows.map((row) => row.projectId);
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
        await this.#projects.forProject(audit.projectId).recordAudit(audit, signal);
        return true;
    };

    private readonly activeAppCount = async (tenantId: string): Promise<number> =>
        await platformDrizzle(this.#database).$count(platformApp, this.tenantActiveApps(tenantId));

    private readonly servedProjectCount = async (tenantId: string): Promise<number> =>
        await platformDrizzle(this.#database).$count(platformProject, this.tenantServedProjects(tenantId));

    /** The Apps a Tenant's App quota counts. */
    private readonly tenantActiveApps = (tenantId: string) => and(eq(platformApp.tenantId, tenantId), appActive);

    /** The Projects a Tenant's Project quota counts. */
    private readonly tenantServedProjects = (tenantId: string) => {
        const database = platformDrizzle(this.#database);
        return and(
            projectServed,
            inArray(
                platformProject.appId,
                database
                    .select({ appId: platformApp.appId })
                    .from(platformApp)
                    .where(eq(platformApp.tenantId, tenantId)),
            ),
        );
    };

    /** Creates an App only for an existing Tenant whose active Apps are below the limit. */
    private readonly appInsert = (app: AppRow, activeAppLimit: number) => {
        const database = platformDrizzle(this.#database);
        return database.insert(platformApp).select(
            database
                .select({
                    appId: sql<string>`${app.app_id}`.as("appId"),
                    tenantId: platformTenant.tenantId,
                    displayName: sql<string>`${app.display_name}`.as("displayName"),
                    lifecycle: sql<"active">`'active'`.as("lifecycle"),
                    initialCredentialId: sql<string | null>`${app.default_credential_id}`.as("initialCredentialId"),
                    createdAt: sql<number>`${app.created_at}`.as("createdAt"),
                    updatedAt: sql<number>`${app.updated_at}`.as("updatedAt"),
                    deletedAt: sql<null>`NULL`.as("deletedAt"),
                })
                .from(platformTenant)
                .where(
                    and(
                        eq(platformTenant.tenantId, app.tenant_id),
                        lt(database.$count(platformApp, this.tenantActiveApps(app.tenant_id)), activeAppLimit),
                    ),
                ),
        );
    };

    /** Creates a Project only under an active App and while the Tenant's served Projects are below the limit. */
    private readonly projectInsert = (project: ProjectRow, activeProjectLimit: number) => {
        const database = platformDrizzle(this.#database);
        return database.insert(platformProject).select(
            database
                .select({
                    projectId: sql<string>`${project.project_id}`.as("projectId"),
                    appId: platformApp.appId,
                    displayName: sql<string>`${project.display_name}`.as("displayName"),
                    clientReference: sql<string>`${project.client_reference}`.as("clientReference"),
                    idempotencyKey: sql<string>`${project.idempotency_key}`.as("idempotencyKey"),
                    requestDigest: sql<string>`${project.request_digest}`.as("requestDigest"),
                    lifecycle: sql<"active">`'active'`.as("lifecycle"),
                    createdAt: sql<number>`${project.created_at}`.as("createdAt"),
                    updatedAt: sql<number>`${project.updated_at}`.as("updatedAt"),
                    deletedAt: sql<null>`NULL`.as("deletedAt"),
                    locationHint: sql<ProjectRow["location_hint"]>`${project.location_hint}`.as("locationHint"),
                })
                .from(platformApp)
                .where(
                    and(
                        eq(platformApp.appId, project.app_id),
                        eq(platformApp.tenantId, project.tenant_id),
                        appActive,
                        lt(
                            database.$count(platformProject, this.tenantServedProjects(project.tenant_id)),
                            activeProjectLimit,
                        ),
                    ),
                ),
        );
    };

    /** Issues an AppCredential only while its App is active. */
    private readonly credentialInsertStatement = (credential: PlatformAppCredentialInsert): D1PreparedStatement => {
        const database = platformDrizzle(this.#database);
        return this.statement(
            database.insert(platformAppCredential).select(
                database
                    .select({
                        credentialId: sql<string>`${credential.credentialId}`.as("credentialId"),
                        publicCredentialId: sql<string>`${credential.publicCredentialId}`.as("publicCredentialId"),
                        appId: platformApp.appId,
                        secretDigest: sql<string>`${credential.secretDigest}`.as("secretDigest"),
                        permissionsJson: sql<string>`${credential.permissionsJson}`.as("permissionsJson"),
                        allProjects: sql<number>`${credential.allProjects ? 1 : 0}`.as("allProjects"),
                        issuedAt: sql<number>`${credential.issuedAt}`.as("issuedAt"),
                        overlapEndsAt: sql<null>`NULL`.as("overlapEndsAt"),
                        replacedByCredentialId: sql<null>`NULL`.as("replacedByCredentialId"),
                        revokedAt: sql<null>`NULL`.as("revokedAt"),
                    })
                    .from(platformApp)
                    .where(and(eq(platformApp.appId, credential.appId), appActive)),
            ),
        );
    };

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

    /**
     * Records the change made by the statement immediately before it in the same batch, and only if that statement
     * changed a row: an audit event is a historical fact, so a write that took no effect leaves none.
     */
    private readonly auditOfPreviousChange = (audit: PlatformAuditRecord): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_dashboard_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
                 ON CONFLICT(audit_id) DO NOTHING`,
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
