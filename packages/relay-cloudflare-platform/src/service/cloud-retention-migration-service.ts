import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import { encodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

export type CloudRetentionMigrationCursor =
    | { readonly kind: "projects"; readonly afterProjectId: string }
    | { readonly kind: "sessions"; readonly projectId: string; readonly afterSessionId: string };

const projectMigrationResult = v.variant("state", [
    v.strictObject({
        state: v.literal("in_progress"),
        migratedSessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        nextAfterSessionId: v.pipe(v.string(), v.minLength(1)),
    }),
    v.strictObject({
        state: v.literal("complete"),
        migratedSessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        sessionCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
]);

type MigrationStorage = Pick<
    PlatformControlPlaneStorage,
    "readCloudRetentionMigrationStatus" | "readNextProjectId" | "recordCloudRetentionMigration"
>;

export class CloudRetentionMigrationService {
    readonly #projects: DurableObjectNamespace;
    readonly #storage: MigrationStorage;

    constructor(storage: MigrationStorage, projects: DurableObjectNamespace) {
        this.#storage = storage;
        this.#projects = projects;
    }

    readonly migrate = async (
        cursor: CloudRetentionMigrationCursor,
        signal: AbortSignal,
    ): Promise<
        | Readonly<{
              state: "complete";
              completedProjects: number;
              totalProjects: number;
          }>
        | Readonly<{
              state: "in_progress";
              cursor: CloudRetentionMigrationCursor;
              migratedProjectId: string;
              migratedSessions: number;
          }>
    > => {
        signal.throwIfAborted();
        const projectId =
            cursor.kind === "sessions"
                ? cursor.projectId
                : await this.#storage.readNextProjectId(cursor.afterProjectId, signal);
        if (projectId === null) {
            const status = await this.status(signal);
            return {
                state: "complete",
                completedProjects: status.completedProjects,
                totalProjects: status.totalProjects,
            };
        }
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PlatformControlPlaneError(
                "cloud_retention_migration_target_invalid",
                "A Platform Project migration target is invalid",
                500,
            );
        }
        const response = await this.#projects
            .getByName(projectId, { locationHint: placement.locationHint })
            .fetch(
                `https://project.internal${encodeProjectDurableObjectPath(projectId, "/migrations/cloud-retention")}`,
                {
                    body: JSON.stringify({ afterSessionId: cursor.kind === "sessions" ? cursor.afterSessionId : "" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                },
            );
        signal.throwIfAborted();
        if (!response.ok) {
            await response.body?.cancel();
            throw new PlatformControlPlaneError(
                "cloud_retention_migration_project_failed",
                "A Project could not be migrated",
                502,
            );
        }
        const parsed = v.safeParse(projectMigrationResult, await response.json());
        if (!parsed.success) {
            throw new PlatformControlPlaneError(
                "cloud_retention_migration_response_invalid",
                "A Project returned an invalid migration result",
                502,
            );
        }
        const value = parsed.output;
        if (value.state === "complete") {
            await this.#storage.recordCloudRetentionMigration(projectId, value.sessionCount, signal);
        }
        return {
            state: "in_progress",
            cursor:
                value.state === "complete"
                    ? { kind: "projects", afterProjectId: projectId }
                    : { kind: "sessions", projectId, afterSessionId: value.nextAfterSessionId },
            migratedProjectId: projectId,
            migratedSessions: value.migratedSessions,
        };
    };

    readonly status = async (
        signal: AbortSignal,
    ): Promise<
        Readonly<{
            complete: boolean;
            completedProjects: number;
            nextIncompleteProjectId: string | null;
            totalProjects: number;
        }>
    > => {
        const status = await this.#storage.readCloudRetentionMigrationStatus(signal);
        return { ...status, complete: status.nextIncompleteProjectId === null };
    };
}
