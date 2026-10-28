import { and, eq } from "drizzle-orm";
import type { PlatformAuditRecord } from "../entity/platform-records.ts";
import type {
    EffectiveRecordingMode,
    ProjectRecordingPolicyTarget,
    RecordingPolicyMode,
    RecordingPolicySource,
    ResolvedRecordingPolicy,
} from "../entity/recording-policy.ts";
import {
    platformApp,
    platformAppRecordingPolicy,
    platformDashboardAuditEvent,
    platformProject,
    platformProjectRecordingPolicy,
} from "../schema/d1/index.ts";
import { type PlatformDrizzleDatabase, platformDrizzle } from "./platform-drizzle-database.ts";

type StoredRecordingMode = EffectiveRecordingMode;

function resolved(
    mode: RecordingPolicyMode,
    projectMode: StoredRecordingMode | null,
    appMode: StoredRecordingMode | null,
): ResolvedRecordingPolicy {
    const candidates: readonly (readonly [StoredRecordingMode | null, RecordingPolicySource])[] = [
        [projectMode, "project"],
        [appMode, "app"],
    ];
    for (const [candidate, source] of candidates) {
        if (candidate !== null) {
            return { effectiveMode: candidate, inheritedFrom: source, mode };
        }
    }
    return { effectiveMode: "disabled", inheritedFrom: "system", mode };
}

export class RecordingPolicyStorage {
    readonly #database: PlatformDrizzleDatabase;

    constructor(database: D1Database) {
        this.#database = platformDrizzle(database);
    }

    readonly projectTarget = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<ProjectRecordingPolicyTarget | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({ appId: platformProject.appId, projectId: platformProject.projectId })
            .from(platformProject)
            .where(and(eq(platformProject.projectId, projectId), eq(platformProject.lifecycle, "active")))
            .limit(1);
        signal.throwIfAborted();
        return rows[0] ?? null;
    };

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({ mode: platformAppRecordingPolicy.mode })
            .from(platformApp)
            .leftJoin(platformAppRecordingPolicy, eq(platformAppRecordingPolicy.appId, platformApp.appId))
            .where(and(eq(platformApp.appId, appId), eq(platformApp.lifecycle, "active")))
            .limit(1);
        signal.throwIfAborted();
        const row = rows[0];
        return row === undefined ? null : resolved(row.mode ?? "inherit", null, row.mode);
    };

    readonly readProject = async (projectId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({ appMode: platformAppRecordingPolicy.mode, projectMode: platformProjectRecordingPolicy.mode })
            .from(platformProject)
            .leftJoin(
                platformProjectRecordingPolicy,
                eq(platformProjectRecordingPolicy.projectId, platformProject.projectId),
            )
            .leftJoin(platformAppRecordingPolicy, eq(platformAppRecordingPolicy.appId, platformProject.appId))
            .where(and(eq(platformProject.projectId, projectId), eq(platformProject.lifecycle, "active")))
            .limit(1);
        signal.throwIfAborted();
        const row = rows[0];
        return row === undefined ? null : resolved(row.projectMode ?? "inherit", row.projectMode, row.appMode);
    };

    readonly writeApp = async (
        appId: string,
        mode: RecordingPolicyMode,
        now: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#database.batch([
            mode === "inherit"
                ? this.#database.delete(platformAppRecordingPolicy).where(eq(platformAppRecordingPolicy.appId, appId))
                : this.#database
                      .insert(platformAppRecordingPolicy)
                      .values({ appId, mode, updatedAt: now })
                      .onConflictDoUpdate({ target: platformAppRecordingPolicy.appId, set: { mode, updatedAt: now } }),
            this.#auditInsert(audit),
        ]);
    };

    readonly writeProject = async (
        projectId: string,
        mode: RecordingPolicyMode,
        now: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#database.batch([
            mode === "inherit"
                ? this.#database
                      .delete(platformProjectRecordingPolicy)
                      .where(eq(platformProjectRecordingPolicy.projectId, projectId))
                : this.#database
                      .insert(platformProjectRecordingPolicy)
                      .values({ mode, projectId, updatedAt: now })
                      .onConflictDoUpdate({
                          target: platformProjectRecordingPolicy.projectId,
                          set: { mode, updatedAt: now },
                      }),
            this.#auditInsert(audit),
        ]);
    };

    /** The policy change and its audit event commit together or not at all. */
    readonly #auditInsert = (audit: PlatformAuditRecord) =>
        this.#database
            .insert(platformDashboardAuditEvent)
            .values({ ...audit, outcome: audit.outcome === "denied" ? "denied" : "succeeded" });
}
