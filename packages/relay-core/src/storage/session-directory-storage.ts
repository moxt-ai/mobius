import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import type { ProjectScope, SessionQuotaPolicy, SessionSummary } from "../entity/do/session.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import { sessionDirectory, sessionQuotaReservation } from "../schema/index.ts";

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

    readonly listReady = async (project: ProjectStorageContext, scope: ProjectScope, signal: AbortSignal) => {
        return relayDrizzle(this.#databases.resolve(project.storagePlacement), signal)
            .select({ session_id: sessionDirectory.sessionId })
            .from(sessionDirectory)
            .where(and(eq(sessionDirectory.projectId, scope.projectId), eq(sessionDirectory.lifecycle, "ready")))
            .orderBy(desc(sessionDirectory.updatedAt), desc(sessionDirectory.sessionId))
            .limit(500);
    };

    readonly listRuntime = async (
        project: ProjectStorageContext,
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => {
        return relayDrizzle(this.#databases.resolve(project.storagePlacement), signal)
            .select({ session_id: sessionDirectory.sessionId })
            .from(sessionDirectory)
            .where(
                and(
                    eq(sessionDirectory.projectId, scope.projectId),
                    eq(sessionDirectory.runtimeId, runtimeId),
                    eq(sessionDirectory.lifecycle, "ready"),
                ),
            )
            .limit(500);
    };

    readonly list = async (
        project: ProjectStorageContext,
        scope: ProjectScope,
        cursor: { readonly updatedAt: number; readonly sessionId: string } | null,
        limit: number,
        signal: AbortSignal,
    ) => {
        const database = relayDrizzle(this.#databases.resolve(project.storagePlacement), signal);
        const condition =
            cursor === null
                ? and(eq(sessionDirectory.projectId, scope.projectId), ne(sessionDirectory.lifecycle, "deleted"))
                : and(
                      eq(sessionDirectory.projectId, scope.projectId),
                      ne(sessionDirectory.lifecycle, "deleted"),
                      or(
                          lt(sessionDirectory.updatedAt, cursor.updatedAt),
                          and(
                              eq(sessionDirectory.updatedAt, cursor.updatedAt),
                              lt(sessionDirectory.sessionId, cursor.sessionId),
                          ),
                      ),
                  );
        return database
            .select({
                session_id: sessionDirectory.sessionId,
                summary_json: sessionDirectory.summaryJson,
                updated_at: sessionDirectory.updatedAt,
            })
            .from(sessionDirectory)
            .where(condition)
            .orderBy(desc(sessionDirectory.updatedAt), desc(sessionDirectory.sessionId))
            .limit(limit) satisfies Promise<readonly DirectoryRow[]>;
    };

    readonly reserve = async (
        project: ProjectStorageContext,
        scope: ProjectScope,
        sessionId: string,
        now: number,
        quota: SessionQuotaPolicy,
        signal: AbortSignal,
    ) => {
        const database = this.#databases.resolve(project.storagePlacement);
        const result = await database
            .prepare(`INSERT INTO session_quota_reservations (
            project_id, session_id, reserved_at
        ) SELECT ?, ?, ?
        WHERE (SELECT COUNT(*) FROM session_quota_reservations WHERE project_id = ?) < ?
        ON CONFLICT(project_id, session_id) DO NOTHING`)
            .bind(scope.projectId, sessionId, now, scope.projectId, quota.activeSessionsPerProject)
            .run(signal);
        const [reservation] = await relayDrizzle(database, signal)
            .select({ session_id: sessionQuotaReservation.sessionId })
            .from(sessionQuotaReservation)
            .where(
                and(
                    eq(sessionQuotaReservation.projectId, scope.projectId),
                    eq(sessionQuotaReservation.sessionId, sessionId),
                ),
            )
            .limit(1);
        return { changes: result.meta.changes, reservation: reservation ?? null };
    };

    readonly release = async (
        project: ProjectStorageContext,
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ) => {
        await relayDrizzle(this.#databases.resolve(project.storagePlacement), signal)
            .delete(sessionQuotaReservation)
            .where(
                and(
                    eq(sessionQuotaReservation.projectId, scope.projectId),
                    eq(sessionQuotaReservation.sessionId, sessionId),
                ),
            );
    };

    readonly read = async (
        project: ProjectStorageContext,
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ) => {
        const [row] = await relayDrizzle(this.#databases.resolve(project.storagePlacement), signal)
            .select({ summary_json: sessionDirectory.summaryJson })
            .from(sessionDirectory)
            .where(and(eq(sessionDirectory.projectId, scope.projectId), eq(sessionDirectory.sessionId, sessionId)))
            .limit(1);
        return row ?? null;
    };

    readonly update = async (
        project: ProjectStorageContext,
        summary: SessionSummary,
        signal: AbortSignal,
    ): Promise<void> => {
        await relayDrizzle(this.#databases.resolve(project.storagePlacement), signal)
            .insert(sessionDirectory)
            .values({
                projectId: summary.projectId,
                sessionId: summary.sessionId,
                runtimeId: summary.runtimeId,
                lifecycle: summary.lifecycle.kind,
                updatedAt: Date.parse(summary.updatedAt),
                summaryJson: JSON.stringify(summary),
            })
            .onConflictDoUpdate({
                target: [sessionDirectory.projectId, sessionDirectory.sessionId],
                set: {
                    runtimeId: summary.runtimeId,
                    lifecycle: summary.lifecycle.kind,
                    updatedAt: Date.parse(summary.updatedAt),
                    summaryJson: JSON.stringify(summary),
                },
            });
    };
}
