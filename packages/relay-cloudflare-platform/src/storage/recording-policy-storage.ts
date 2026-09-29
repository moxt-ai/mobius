import { and, eq } from "drizzle-orm";
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
    platformSessionRecordingPolicy,
} from "../schema/d1/index.ts";
import { type PlatformDrizzleDatabase, platformDrizzle } from "./platform-drizzle-database.ts";

type StoredRecordingMode = EffectiveRecordingMode;

function resolved(
    mode: RecordingPolicyMode,
    sessionMode: StoredRecordingMode | null,
    projectMode: StoredRecordingMode | null,
    appMode: StoredRecordingMode | null,
): ResolvedRecordingPolicy {
    const candidates: readonly (readonly [StoredRecordingMode | null, RecordingPolicySource])[] = [
        [sessionMode, "session"],
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
        return row === undefined ? null : resolved(row.mode ?? "inherit", null, null, row.mode);
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
        return row === undefined ? null : resolved(row.projectMode ?? "inherit", null, row.projectMode, row.appMode);
    };

    readonly readSession = async (
        projectId: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<ResolvedRecordingPolicy | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({
                appMode: platformAppRecordingPolicy.mode,
                projectMode: platformProjectRecordingPolicy.mode,
                sessionMode: platformSessionRecordingPolicy.mode,
            })
            .from(platformProject)
            .leftJoin(
                platformProjectRecordingPolicy,
                eq(platformProjectRecordingPolicy.projectId, platformProject.projectId),
            )
            .leftJoin(platformAppRecordingPolicy, eq(platformAppRecordingPolicy.appId, platformProject.appId))
            .leftJoin(
                platformSessionRecordingPolicy,
                and(
                    eq(platformSessionRecordingPolicy.projectId, platformProject.projectId),
                    eq(platformSessionRecordingPolicy.sessionId, sessionId),
                ),
            )
            .where(and(eq(platformProject.projectId, projectId), eq(platformProject.lifecycle, "active")))
            .limit(1);
        signal.throwIfAborted();
        const row = rows[0];
        return row === undefined
            ? null
            : resolved(row.sessionMode ?? "inherit", row.sessionMode, row.projectMode, row.appMode);
    };

    readonly writeApp = async (
        appId: string,
        mode: RecordingPolicyMode,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (mode === "inherit") {
            await this.#database.delete(platformAppRecordingPolicy).where(eq(platformAppRecordingPolicy.appId, appId));
        } else {
            await this.#database
                .insert(platformAppRecordingPolicy)
                .values({ appId, mode, updatedAt: now })
                .onConflictDoUpdate({ target: platformAppRecordingPolicy.appId, set: { mode, updatedAt: now } });
        }
        signal.throwIfAborted();
    };

    readonly writeProject = async (
        projectId: string,
        mode: RecordingPolicyMode,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (mode === "inherit") {
            await this.#database
                .delete(platformProjectRecordingPolicy)
                .where(eq(platformProjectRecordingPolicy.projectId, projectId));
        } else {
            await this.#database
                .insert(platformProjectRecordingPolicy)
                .values({ mode, projectId, updatedAt: now })
                .onConflictDoUpdate({
                    target: platformProjectRecordingPolicy.projectId,
                    set: { mode, updatedAt: now },
                });
        }
        signal.throwIfAborted();
    };

    readonly writeSession = async (
        projectId: string,
        sessionId: string,
        mode: RecordingPolicyMode,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (mode === "inherit") {
            await this.#database
                .delete(platformSessionRecordingPolicy)
                .where(
                    and(
                        eq(platformSessionRecordingPolicy.projectId, projectId),
                        eq(platformSessionRecordingPolicy.sessionId, sessionId),
                    ),
                );
        } else {
            await this.#database
                .insert(platformSessionRecordingPolicy)
                .values({ mode, projectId, sessionId, updatedAt: now })
                .onConflictDoUpdate({
                    target: [platformSessionRecordingPolicy.projectId, platformSessionRecordingPolicy.sessionId],
                    set: { mode, updatedAt: now },
                });
        }
        signal.throwIfAborted();
    };
}
