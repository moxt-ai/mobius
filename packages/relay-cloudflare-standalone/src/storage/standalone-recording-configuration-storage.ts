import { relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { pairingChannel } from "@moxt-ai/mobius-relay-core/schema";
import { count, eq } from "drizzle-orm";
import { standaloneRecordingConfiguration } from "../schema/d1/standalone-recording-configuration.ts";

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

    readonly read = async (signal: AbortSignal): Promise<StandaloneRecordingConfiguration> => {
        const database = relayDrizzle(this.#database, signal);
        const configured = await database
            .select({ enabled: standaloneRecordingConfiguration.enabled })
            .from(standaloneRecordingConfiguration)
            .where(eq(standaloneRecordingConfiguration.singleton, 1))
            .limit(1);
        const row = configured[0];
        if (row !== undefined) {
            return { enabled: row.enabled, state: "configured" };
        }
        const pairingCount = await database.select({ value: count() }).from(pairingChannel);
        signal.throwIfAborted();
        return (pairingCount[0]?.value ?? 0) > 0 ? { enabled: false, state: "configured" } : { state: "unconfigured" };
    };

    readonly configure = async (
        enabled: boolean,
        now: number,
        signal: AbortSignal,
    ): Promise<StandaloneRecordingConfigurationWrite> => {
        const current = await this.read(signal);
        if (current.state === "configured") {
            return { enabled: current.enabled, kind: "locked" };
        }
        try {
            await relayDrizzle(this.#database, signal)
                .insert(standaloneRecordingConfiguration)
                .values({ configuredAt: now, enabled, singleton: 1 });
            signal.throwIfAborted();
            return { enabled, kind: "configured" };
        } catch (cause) {
            signal.throwIfAborted();
            const resolved = await this.read(signal);
            if (resolved.state === "configured") {
                return { enabled: resolved.enabled, kind: "locked" };
            }
            throw cause;
        }
    };
}
