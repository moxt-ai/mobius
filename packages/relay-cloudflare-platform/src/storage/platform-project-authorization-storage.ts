import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";
import { type PlatformProjectScopeRow, PlatformProjectScopeRowSchema } from "../entity/platform-records.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import {
    type PlatformDatabaseResolver,
    type PlatformProjectDatabase,
    projectDatabase,
} from "./platform-database-resolver.ts";

export class PlatformProjectAuthorizationStorage {
    readonly #databases: PlatformDatabaseResolver;

    constructor(databases: PlatformDatabaseResolver) {
        this.#databases = databases;
    }

    readonly read = async (projectId: string, signal: AbortSignal): Promise<PlatformProjectScopeRow | null> => {
        const database = this.database(projectId);
        const row = await this.operation(
            () =>
                database
                    .prepare(
                        `SELECT project_id, app_id, tenant_id,
                                CASE WHEN EXISTS (
                                    SELECT 1 FROM platform_project_app_revocations
                                     WHERE app_id = projects.app_id
                                ) THEN 'deleted' ELSE lifecycle END AS lifecycle
                           FROM platform_project_authorizations AS projects WHERE project_id = ?`,
                    )
                    .bind(projectId)
                    .first(),
            signal,
        );
        return decodeOptionalStorageRecord(PlatformProjectScopeRowSchema, row);
    };

    readonly create = async (project: PlatformProjectScopeRow, signal: AbortSignal): Promise<void> => {
        const database = this.database(project.project_id);
        await this.operation(
            () =>
                database
                    .prepare(
                        `INSERT INTO platform_project_authorizations (project_id, app_id, tenant_id, lifecycle)
                         VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING`,
                    )
                    .bind(project.project_id, project.app_id, project.tenant_id, project.lifecycle)
                    .run(),
            signal,
        );
        const stored = await this.read(project.project_id, signal);
        if (stored === null || stored.app_id !== project.app_id || stored.tenant_id !== project.tenant_id) {
            throw new DatabaseError("database_unavailable", "Project authorization could not be created");
        }
    };

    readonly revokeApp = async (appId: string, projectIds: readonly string[], signal: AbortSignal): Promise<void> => {
        for (const projectId of projectIds) {
            const database = this.database(projectId);
            await this.operation(
                () =>
                    database
                        .prepare(
                            `INSERT INTO platform_project_app_revocations (app_id)
                             VALUES (?) ON CONFLICT(app_id) DO NOTHING`,
                        )
                        .bind(appId)
                        .run(),
                signal,
            );
        }
    };

    private readonly database = (projectId: string): PlatformProjectDatabase =>
        projectDatabase(this.#databases, projectId);

    private readonly operation = async <Value>(
        operation: () => Promise<Value>,
        signal: AbortSignal,
    ): Promise<Value> => {
        signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 15_000);
        const deadline = AbortSignal.any([signal, timeout.signal]);
        let abort = (): void => {};
        try {
            const value = await Promise.race([
                operation(),
                new Promise<never>((_resolve, reject) => {
                    abort = () => reject(deadline.reason);
                    deadline.addEventListener("abort", abort, { once: true });
                    if (deadline.aborted) {
                        abort();
                    }
                }),
            ]);
            deadline.throwIfAborted();
            return value;
        } catch (cause) {
            signal.throwIfAborted();
            throw new DatabaseError(
                timeout.signal.aborted ? "database_timeout" : "database_unavailable",
                "Project storage is unavailable",
                { cause },
            );
        } finally {
            clearTimeout(timer);
            deadline.removeEventListener("abort", abort);
        }
    };
}
