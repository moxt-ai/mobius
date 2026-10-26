import type { CatalogAgent as CatalogAgentDefinition } from "../../agent/catalog.ts";
import type { discoverLocalAgentInventory } from "../../agent/discovery/discover-local-agents.ts";
import { revalidateExecutable } from "../../util/process/executable.ts";
import { type RuntimeConfig, withRuntimeEnvironment } from "../config.ts";

/** The definition a command for `agentId` runs against, re-discovered when its executable changed. */
export async function resolveCatalogAgent(
    config: RuntimeConfig,
    agentId: string,
    signal: AbortSignal,
): Promise<CatalogAgentDefinition> {
    const agent = config.catalog.find(agentId);
    return config.resolveAgent === undefined ? agent : await config.resolveAgent(agent, signal);
}

type DiscoverInventory = (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof discoverLocalAgentInventory>>>;
type PublishCatalog = (config: RuntimeConfig, signal: AbortSignal) => Promise<void>;

/**
 * Resolves the Agent definition a command should run against. The cataloged snapshot is served
 * while its executables still match discovery; once an upgrade replaces them, the Agent is
 * re-discovered and the catalog entry is swapped so new conversations and settings discovery use
 * the upgraded runtime. A failed publication rolls the swap back, keeping the relay-facing catalog
 * consistent with what this daemon would actually spawn. Concurrent commands for the same Agent
 * share one refresh instead of racing probes against the same binary, and the swap commits
 * through the catalog's serialized replacement so it neither overlaps nor clobbers a full discovery.
 */
export function createCatalogAgentResolver(
    discover: DiscoverInventory,
    readConfig: () => RuntimeConfig,
    publish: PublishCatalog,
): NonNullable<RuntimeConfig["resolveAgent"]> {
    const swaps = new Map<string, Promise<void>>();
    return async (agent, signal) => {
        const config = readConfig();
        const pending = swaps.get(agent.id);
        if (pending !== undefined) {
            await pending;
            return config.catalog.find(agent.id);
        }
        let release = (): void => undefined;
        const gate = new Promise<void>((resolveGate) => {
            release = resolveGate;
        });
        swaps.set(agent.id, gate);
        try {
            if (await unchangedIdentity(agent, signal)) {
                return agent;
            }
            signal.throwIfAborted();
            const inventory = await discover(signal);
            signal.throwIfAborted();
            const rediscovered = inventory
                .readyAgents()
                .filter((ready) => ready.id === agent.id)
                .map((ready) => withRuntimeEnvironment(ready, config.localContext.environment));
            await config.catalog.replaceAndPublish(
                (current) => {
                    if (!current.some((entry) => entry.id === agent.id)) {
                        throw new Error(`The local Agent ${agent.id} left the catalog before its refresh completed`);
                    }
                    return [...current.filter((entry) => entry.id !== agent.id), ...rediscovered];
                },
                (publishSignal) => publish(config, publishSignal),
                signal,
            );
            return config.catalog.find(agent.id);
        } finally {
            swaps.delete(agent.id);
            release();
        }
    };
}

async function unchangedIdentity(agent: CatalogAgentDefinition, signal: AbortSignal): Promise<boolean> {
    if (!(await revalidateExecutable(agent.agentIdentity))) {
        return false;
    }
    signal.throwIfAborted();
    return agent.kind !== "acp-adapter-process" || (await revalidateExecutable(agent.adapterIdentity));
}
