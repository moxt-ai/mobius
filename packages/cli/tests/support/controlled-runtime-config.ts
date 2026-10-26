import type { CatalogAgent } from "../../src/agent/catalog.ts";
import { RuntimeAgentDependencies } from "../../src/agent/runtime-agents.ts";
import {
    createRuntimeConfig,
    type RuntimeConfig,
    type RuntimeConnectionConfig,
    type RuntimeLocalContext,
    type RuntimeReconnectTarget,
} from "../../src/runtime/config.ts";
import { acpAdapters } from "./acp-adapters.ts";

/** Injects only the controlled Agent dependency; runtime services and transports remain production code. */
export function createControlledRuntimeConfig(
    connection: RuntimeConnectionConfig,
    agents: readonly CatalogAgent[] = [],
    context?: RuntimeLocalContext,
    reconnectTarget?: RuntimeReconnectTarget | null,
    resolveAgent?: RuntimeConfig["resolveAgent"],
    rediscoverAgents?: RuntimeConfig["rediscoverAgents"],
): RuntimeConfig {
    return createRuntimeConfig(
        connection,
        new RuntimeAgentDependencies(agents, acpAdapters),
        context,
        reconnectTarget,
        resolveAgent,
        rediscoverAgents,
    );
}
