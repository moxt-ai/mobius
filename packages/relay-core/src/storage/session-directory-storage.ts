import type { ProjectScope, SessionQuotaPolicy, SessionSummary } from "../entity/do/session.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { TenantContext } from "../infra/tenant-sharding-directory.ts";

interface DirectoryRow {
    readonly session_id: string;
    readonly summary_json: string;
    readonly updated_at: number;
}

export class SessionDirectoryStorage {
    readonly #databases: DatabaseResolver;

    constructor(databases: DatabaseResolver) {
        this.#databases = databases;
    }

    readonly listReady = async (tenant: TenantContext, scope: ProjectScope, signal: AbortSignal) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        return (
            await database
                .prepare(`SELECT session_id FROM session_directory
            WHERE tenant_id = ? AND project_id = ? AND lifecycle = 'ready'
            ORDER BY updated_at DESC, session_id DESC LIMIT 500`)
                .bind(scope.tenantId, scope.projectId)
                .all<{ readonly session_id: string }>(signal)
        ).results;
    };

    readonly listRuntime = async (
        tenant: TenantContext,
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        return (
            await database
                .prepare(`SELECT session_id FROM session_directory
            WHERE tenant_id = ? AND project_id = ? AND runtime_id = ? AND lifecycle = 'ready' LIMIT 500`)
                .bind(scope.tenantId, scope.projectId, runtimeId)
                .all<{ readonly session_id: string }>(signal)
        ).results;
    };

    readonly list = async (
        tenant: TenantContext,
        scope: ProjectScope,
        cursor: { readonly updatedAt: number; readonly sessionId: string } | null,
        limit: number,
        signal: AbortSignal,
    ) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        const statement =
            cursor === null
                ? database
                      .prepare(`SELECT session_id, summary_json, updated_at FROM session_directory
                WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'
                ORDER BY updated_at DESC, session_id DESC LIMIT ?`)
                      .bind(scope.tenantId, scope.projectId, limit)
                : database
                      .prepare(`SELECT session_id, summary_json, updated_at FROM session_directory
                WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'
                AND (updated_at < ? OR (updated_at = ? AND session_id < ?))
                ORDER BY updated_at DESC, session_id DESC LIMIT ?`)
                      .bind(
                          scope.tenantId,
                          scope.projectId,
                          cursor.updatedAt,
                          cursor.updatedAt,
                          cursor.sessionId,
                          limit,
                      );
        return (await statement.all<DirectoryRow>(signal)).results;
    };

    readonly reserve = async (
        tenant: TenantContext,
        scope: ProjectScope,
        sessionId: string,
        now: number,
        quota: SessionQuotaPolicy,
        signal: AbortSignal,
    ) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        const result = await database
            .prepare(`INSERT INTO session_quota_reservations (
            tenant_id, project_id, session_id, reserved_at
        ) SELECT ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM session_quota_reservations WHERE tenant_id = ?) < ?
            AND (SELECT COUNT(*) FROM session_quota_reservations WHERE tenant_id = ? AND project_id = ?) < ?
        ON CONFLICT(tenant_id, project_id, session_id) DO NOTHING`)
            .bind(
                scope.tenantId,
                scope.projectId,
                sessionId,
                now,
                scope.tenantId,
                quota.activeSessionsPerTenant,
                scope.tenantId,
                scope.projectId,
                quota.activeSessionsPerProject,
            )
            .run(signal);
        const reservation = await database
            .prepare(`SELECT session_id FROM session_quota_reservations
            WHERE tenant_id = ? AND project_id = ? AND session_id = ?`)
            .bind(scope.tenantId, scope.projectId, sessionId)
            .first<{ readonly session_id: string }>(signal);
        return { changes: result.meta.changes, reservation };
    };

    readonly release = async (tenant: TenantContext, scope: ProjectScope, sessionId: string, signal: AbortSignal) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        await database
            .prepare(`DELETE FROM session_quota_reservations
            WHERE tenant_id = ? AND project_id = ? AND session_id = ?`)
            .bind(scope.tenantId, scope.projectId, sessionId)
            .run(signal);
    };

    readonly read = async (tenant: TenantContext, scope: ProjectScope, sessionId: string, signal: AbortSignal) => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        return database
            .prepare(`SELECT summary_json FROM session_directory
            WHERE tenant_id = ? AND project_id = ? AND session_id = ?`)
            .bind(scope.tenantId, scope.projectId, sessionId)
            .first<{ readonly summary_json: string }>(signal);
    };

    readonly update = async (tenant: TenantContext, summary: SessionSummary, signal: AbortSignal): Promise<void> => {
        const database = this.#databases.resolve(tenant.tenantSharding);
        await database
            .prepare(`INSERT INTO session_directory (
            tenant_id, project_id, session_id, runtime_id, lifecycle, updated_at, summary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, project_id, session_id) DO UPDATE SET
            runtime_id = excluded.runtime_id, lifecycle = excluded.lifecycle,
            updated_at = excluded.updated_at, summary_json = excluded.summary_json`)
            .bind(
                summary.tenantId,
                summary.projectId,
                summary.sessionId,
                summary.runtimeId,
                summary.lifecycle.kind,
                Date.parse(summary.updatedAt),
                JSON.stringify(summary),
            )
            .run(signal);
    };
}
