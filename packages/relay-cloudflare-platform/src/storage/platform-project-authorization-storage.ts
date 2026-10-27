import { DatabaseError, relayDrizzle } from "@moxt-ai/mobius-relay-core/database";
import {
    platformProjectAppRevocation,
    platformProjectAuthorization,
} from "@moxt-ai/mobius-relay-core/schema/project-do";
import { eq } from "drizzle-orm";
import {
    type PlatformProjectAuthorizationRow,
    PlatformProjectAuthorizationRowSchema,
} from "../entity/platform-project-authorization.ts";
import type { PlatformProjectScopeRow } from "../entity/platform-records.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { type PlatformDatabaseResolver, projectSqlDatabase } from "./platform-database-resolver.ts";

export class PlatformProjectAuthorizationStorage {
    readonly #databases: PlatformDatabaseResolver;

    constructor(databases: PlatformDatabaseResolver) {
        this.#databases = databases;
    }

    readonly read = async (projectId: string, signal: AbortSignal): Promise<PlatformProjectAuthorizationRow | null> => {
        const database = relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal);
        const projects = await this.operation(
            () =>
                database
                    .select({
                        project_id: platformProjectAuthorization.projectId,
                        app_id: platformProjectAuthorization.appId,
                        lifecycle: platformProjectAuthorization.lifecycle,
                    })
                    .from(platformProjectAuthorization)
                    .where(eq(platformProjectAuthorization.projectId, projectId))
                    .limit(1),
            signal,
        );
        const project = projects[0];
        if (project === undefined) {
            return null;
        }
        const revocations = await this.operation(
            () =>
                database
                    .select({ app_id: platformProjectAppRevocation.appId })
                    .from(platformProjectAppRevocation)
                    .where(eq(platformProjectAppRevocation.appId, project.app_id))
                    .limit(1),
            signal,
        );
        const revoked = revocations.length > 0;
        return decodeOptionalStorageRecord(PlatformProjectAuthorizationRowSchema, {
            ...project,
            lifecycle: revoked ? "deleted" : project.lifecycle,
        });
    };

    readonly create = async (project: PlatformProjectScopeRow, signal: AbortSignal): Promise<void> => {
        const database = relayDrizzle(projectSqlDatabase(this.#databases, project.project_id), signal);
        await this.operation(
            () =>
                database
                    .insert(platformProjectAuthorization)
                    .values({
                        projectId: project.project_id,
                        appId: project.app_id,
                        lifecycle: project.lifecycle,
                    })
                    .onConflictDoNothing({ target: platformProjectAuthorization.projectId }),
            signal,
        );
        const stored = await this.read(project.project_id, signal);
        if (stored === null || stored.app_id !== project.app_id) {
            throw new DatabaseError("database_unavailable", "Project authorization could not be created");
        }
    };

    readonly revokeApp = async (appId: string, projectIds: readonly string[], signal: AbortSignal): Promise<void> => {
        for (const projectId of projectIds) {
            const database = relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal);
            await this.operation(
                () =>
                    database
                        .insert(platformProjectAppRevocation)
                        .values({ appId })
                        .onConflictDoNothing({ target: platformProjectAppRevocation.appId }),
                signal,
            );
        }
    };

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
