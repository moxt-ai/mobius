import { type AppUpgradeTask, appUpgradeTaskSchema } from "@moxt-ai/mobius-protocol";
import { relayDrizzle } from "@moxt-ai/mobius-relay-core/database";
import { and, asc, eq, gt } from "drizzle-orm";
import { platformAppUpgrade, platformProject } from "../schema/d1/index.ts";
import { pairingChannel } from "../schema/project-do/pairing-channel.ts";
import { waitForD1 } from "./d1-operation.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    projectSqlDatabase,
} from "./platform-database-resolver.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";

export class AppUpgradeStorage {
    readonly #database;
    readonly #projects: PlatformDatabaseResolver;
    constructor(bindings: PlatformStorageBindings & { readonly PLATFORM_DIRECTORY_DATABASE: D1Database }) {
        this.#database = platformDrizzle(bindings.PLATFORM_DIRECTORY_DATABASE);
        this.#projects = new PlatformDatabaseResolver(bindings);
    }
    readonly read = async (appId: string, signal: AbortSignal): Promise<AppUpgradeTask | null> => {
        const rows = await waitForD1(
            () => this.#database.select().from(platformAppUpgrade).where(eq(platformAppUpgrade.appId, appId)).limit(1),
            signal,
        );
        return rows[0] === undefined ? null : appUpgradeTaskSchema.parse(rows[0]);
    };
    readonly write = async (appId: string, task: AppUpgradeTask | null, signal: AbortSignal): Promise<void> => {
        await waitForD1(async () => {
            if (task === null) {
                await this.#database.delete(platformAppUpgrade).where(eq(platformAppUpgrade.appId, appId));
            } else {
                await this.#database
                    .insert(platformAppUpgrade)
                    .values({ appId, ...task })
                    .onConflictDoUpdate({ target: platformAppUpgrade.appId, set: task });
            }
        }, signal);
    };
    readonly projectApp = async (projectId: string, signal: AbortSignal): Promise<string | null> => {
        const rows = await waitForD1(
            () =>
                this.#database
                    .select({ appId: platformProject.appId })
                    .from(platformProject)
                    .where(and(eq(platformProject.projectId, projectId), eq(platformProject.lifecycle, "active")))
                    .limit(1),
            signal,
        );
        return rows[0]?.appId ?? null;
    };
    readonly projects = async (appId: string, after: string, signal: AbortSignal) =>
        await waitForD1(
            () =>
                this.#database
                    .select({ projectId: platformProject.projectId })
                    .from(platformProject)
                    .where(
                        and(
                            eq(platformProject.appId, appId),
                            eq(platformProject.lifecycle, "active"),
                            gt(platformProject.projectId, after),
                        ),
                    )
                    .orderBy(asc(platformProject.projectId))
                    .limit(2),
            signal,
        );
    readonly runtimes = async (projectId: string, after: string, signal: AbortSignal) => {
        const database = relayDrizzle(projectSqlDatabase(this.#projects, projectId), signal);
        return await database
            .select({
                runtimeId: pairingChannel.runtimeId,
                projectId: pairingChannel.projectId,
                name: pairingChannel.machineName,
            })
            .from(pairingChannel)
            .where(
                and(
                    eq(pairingChannel.projectId, projectId),
                    eq(pairingChannel.status, "paired"),
                    gt(pairingChannel.runtimeId, after),
                ),
            )
            .orderBy(asc(pairingChannel.runtimeId))
            .limit(21);
    };
}
