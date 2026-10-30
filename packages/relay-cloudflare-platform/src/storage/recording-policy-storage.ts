import { and, eq, exists, sql } from "drizzle-orm";
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
    platformProject,
    platformProjectRecordingPolicy,
} from "../schema/d1/index.ts";
import { activeAppConfigurationTarget, appConfigurationAudit } from "./app-configuration-write.ts";
import { type PlatformDrizzleDatabase, platformDrizzle } from "./platform-drizzle-database.ts";
import { appActive, projectServed } from "./platform-lifecycle.ts";

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
            .where(and(eq(platformProject.projectId, projectId), projectServed))
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
            .where(and(eq(platformApp.appId, appId), appActive))
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
            .where(and(eq(platformProject.projectId, projectId), projectServed))
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
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const target = activeAppConfigurationTarget(this.#database, appId).as("active_app");
        const active = exists(this.#database.select().from(target));
        const [, auditRows] = await this.#database.batch([
            mode === "inherit"
                ? this.#database
                      .delete(platformAppRecordingPolicy)
                      .where(and(eq(platformAppRecordingPolicy.appId, appId), active))
                : this.#database
                      .insert(platformAppRecordingPolicy)
                      .select(
                          this.#database
                              .select({
                                  appId: target.appId,
                                  mode: sql<StoredRecordingMode>`${mode}`.as("mode"),
                                  updatedAt: sql<number>`${now}`.as("updatedAt"),
                              })
                              .from(target)
                              .where(eq(target.appId, appId)),
                      )
                      .onConflictDoUpdate({ target: platformAppRecordingPolicy.appId, set: { mode, updatedAt: now } }),
            appConfigurationAudit(this.#database, audit),
        ]);
        return auditRows.length === 1;
    };

    readonly writeProject = async (
        projectId: string,
        mode: RecordingPolicyMode,
        now: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const target = this.#database
            .select({ projectId: platformProject.projectId })
            .from(platformProject)
            .where(and(eq(platformProject.projectId, projectId), projectServed))
            .as("active_project");
        const active = exists(this.#database.select().from(target));
        const [, auditRows] = await this.#database.batch([
            mode === "inherit"
                ? this.#database
                      .delete(platformProjectRecordingPolicy)
                      .where(and(eq(platformProjectRecordingPolicy.projectId, projectId), active))
                : this.#database
                      .insert(platformProjectRecordingPolicy)
                      .select(
                          this.#database
                              .select({
                                  projectId: target.projectId,
                                  mode: sql<StoredRecordingMode>`${mode}`.as("mode"),
                                  updatedAt: sql<number>`${now}`.as("updatedAt"),
                              })
                              .from(target)
                              .where(eq(target.projectId, projectId)),
                      )
                      .onConflictDoUpdate({
                          target: platformProjectRecordingPolicy.projectId,
                          set: { mode, updatedAt: now },
                      }),
            appConfigurationAudit(this.#database, audit, active),
        ]);
        return auditRows.length === 1;
    };
}
