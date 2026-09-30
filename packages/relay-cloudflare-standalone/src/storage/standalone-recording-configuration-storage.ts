import { relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { eq } from "drizzle-orm";
import { standaloneProjectRecordingConfiguration } from "../schema/d1/standalone-project-recording-configuration.ts";

export type StandaloneRecordingConfiguration =
    | { readonly state: "unconfigured" }
    | { readonly enabled: boolean; readonly state: "configured" };

export type StandaloneRecordingConfigurationWrite =
    | { readonly kind: "configured"; readonly enabled: boolean }
    | { readonly kind: "locked"; readonly enabled: boolean };

export class StandaloneRecordingConfigurationStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly read = async (projectId: string, signal: AbortSignal): Promise<StandaloneRecordingConfiguration> => {
        const database = relayDrizzle(this.#database, signal);
        const configured = await database
            .select({ enabled: standaloneProjectRecordingConfiguration.enabled })
            .from(standaloneProjectRecordingConfiguration)
            .where(eq(standaloneProjectRecordingConfiguration.projectId, projectId))
            .limit(1);
        const row = configured[0];
        if (row !== undefined) {
            return { enabled: row.enabled, state: "configured" };
        }
        signal.throwIfAborted();
        return { state: "unconfigured" };
    };

    readonly configure = async (
        projectId: string,
        enabled: boolean,
        now: number,
        signal: AbortSignal,
    ): Promise<StandaloneRecordingConfigurationWrite> => {
        const current = await this.read(projectId, signal);
        if (current.state === "configured") {
            return { enabled: current.enabled, kind: "locked" };
        }
        try {
            await relayDrizzle(this.#database, signal)
                .insert(standaloneProjectRecordingConfiguration)
                .values({ configuredAt: now, enabled, projectId });
            signal.throwIfAborted();
            return { enabled, kind: "configured" };
        } catch (cause) {
            signal.throwIfAborted();
            const resolved = await this.read(projectId, signal);
            if (resolved.state === "configured") {
                return { enabled: resolved.enabled, kind: "locked" };
            }
            throw cause;
        }
    };
}
