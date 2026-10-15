import { type AppUpgradeInput, appUpgradeInputSchema, type RuntimeUpgradeSnapshot } from "@moxt-ai/mobius-protocol";
import type { VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { rolloutMatches } from "../entity/runtime-rollout.ts";
import type { RuntimeUpgradeGateway } from "../gateway/runtime-upgrade-gateway.ts";
import type { AppUpgradeStorage } from "../storage/app-upgrade-storage.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";
export class AppUpgradeService {
    private readonly control: PlatformControlPlaneService;
    private readonly storage: AppUpgradeStorage;
    private readonly gateway: RuntimeUpgradeGateway;
    private readonly waitUntil: (operation: Promise<void>) => void;
    constructor(
        control: PlatformControlPlaneService,
        storage: AppUpgradeStorage,
        gateway: RuntimeUpgradeGateway,
        waitUntil: (operation: Promise<void>) => void,
    ) {
        this.control = control;
        this.storage = storage;
        this.gateway = gateway;
        this.waitUntil = waitUntil;
    }
    private readonly authorize = async (identity: VerifiedExternalIdentity, appId: string, signal: AbortSignal) => {
        await this.control.readPlatformConfiguration(identity, signal);
        await this.control.requireAppDeveloper(identity, appId, signal);
    };
    readonly read = async (identity: VerifiedExternalIdentity, appId: string, signal: AbortSignal) => {
        await this.authorize(identity, appId, signal);
        return { task: await this.storage.read(appId, signal) };
    };
    readonly write = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        input: AppUpgradeInput | null,
        signal: AbortSignal,
    ) => {
        await this.authorize(identity, appId, signal);
        const task =
            input === null
                ? null
                : { ...appUpgradeInputSchema.parse(input), revision: crypto.randomUUID(), updatedAt: Date.now() };
        await this.storage.write(appId, task, signal);
        if (task !== null) {
            this.waitUntil(
                this.dispatch(appId, task.revision, AbortSignal.timeout(120_000)).catch(() => {
                    console.warn("Upgrade dispatch incomplete; connected Runtimes will check the current task");
                }),
            );
        }
        return { task };
    };
    readonly page = async (identity: VerifiedExternalIdentity, appId: string, cursor: string, signal: AbortSignal) => {
        await this.authorize(identity, appId, signal);
        return await this.query(appId, cursor, false, signal);
    };
    private readonly query = async (appId: string, cursor: string, dispatch: boolean, signal: AbortSignal) => {
        const parts = cursor.split("|");
        if (parts.length > 2 || cursor.length > 512) {
            throw new PlatformControlPlaneError("invalid_request", "Invalid Runtime cursor", 400);
        }
        const afterProject = parts[0] ?? "",
            afterRuntime = parts[1] ?? "";
        // Cursor uses the previous project, plus a Runtime position within the next project.
        const projects = await this.storage.projects(appId, afterProject, signal);
        const project = projects[0];
        const task = await this.storage.read(appId, signal);
        if (project === undefined) {
            return { task, runtimes: [], next: null, queriedAt: Date.now() };
        }
        let rows: Awaited<ReturnType<AppUpgradeStorage["runtimes"]>>;
        try {
            rows = await this.storage.runtimes(project.projectId, afterRuntime, signal);
        } catch (error) {
            signal.throwIfAborted();
            throw new PlatformControlPlaneError(
                "project_unavailable",
                "Project Runtime directory is unavailable; retry this page",
                503,
                { cause: error },
            );
        }
        const runtimes: RuntimeUpgradeSnapshot[] = [];
        for (let offset = 0; offset < Math.min(rows.length, 20); offset += 4) {
            const batch = await Promise.all(
                rows.slice(offset, Math.min(offset + 4, 20)).map(async (row): Promise<RuntimeUpgradeSnapshot> => {
                    const matched = task !== null && (await rolloutMatches(row.runtimeId, task.percentage));
                    try {
                        const value = await this.gateway.request(
                            row.runtimeId,
                            row.projectId,
                            dispatch && matched,
                            AbortSignal.any([signal, AbortSignal.timeout(2000)]),
                        );
                        return { ...value, name: row.name, matched };
                    } catch {
                        signal.throwIfAborted();
                        return {
                            ...row,
                            matched,
                            connection: "unknown",
                            version: null,
                            lastSeen: null,
                            attempt: null,
                            latest: null,
                            lastFailure: null,
                        };
                    }
                }),
            );
            runtimes.push(...batch);
        }
        const last = runtimes.at(-1);
        const next =
            rows.length > 20 && last !== undefined
                ? `${afterProject}|${last.runtimeId}`
                : projects.length > 1
                  ? project.projectId
                  : null;
        return { task, runtimes, next, queriedAt: Date.now() };
    };
    private readonly dispatch = async (appId: string, revision: string, signal: AbortSignal) => {
        let cursor = "";
        for (;;) {
            if ((await this.storage.read(appId, signal))?.revision !== revision) {
                return;
            }
            const page = await this.query(appId, cursor, true, signal);
            if (page.next === null) {
                return;
            }
            cursor = page.next;
        }
    };
}
