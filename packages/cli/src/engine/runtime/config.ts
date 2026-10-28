import { resolve } from "node:path";
import { RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-sdk/protocol";
import type { CatalogAgent } from "../agent/catalog.ts";
import { LocalAgentCatalog } from "../agent/catalog.ts";
import type { RuntimeAgentDependencies } from "../agent/runtime-agents.ts";

/**
 * Where a Runtime keeps its local data, and the environment it runs and launches Agents with. The data directory is
 * passed explicitly and never selected from the Agent launch environment.
 */
export class RuntimeLocalContext {
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;
    readonly maxAcpProcesses: number;

    constructor(stateDirectory: string, agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>, maxAcpProcesses = 1000) {
        this.stateDirectory = resolve(stateDirectory);
        this.agentLaunchEnvironment = Object.freeze({ ...agentLaunchEnvironment });
        this.maxAcpProcesses = maxAcpProcesses;
    }
}

export function withRuntimeEnvironment(agent: CatalogAgent, environment: Readonly<NodeJS.ProcessEnv>): CatalogAgent {
    const launchEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") {
            launchEnvironment[name] = value;
        }
    }
    return agent.withEnvironment({ ...launchEnvironment, ...agent.environment });
}

export abstract class RuntimeReconnectTarget {
    abstract readonly commandArgument: string;
}

export class OpaqueRuntimeReconnectTarget extends RuntimeReconnectTarget {
    readonly connectionId: string;
    readonly commandArgument: string;

    constructor(connectionId: string) {
        super();
        this.connectionId = connectionId;
        this.commandArgument = `--connection ${connectionId}`;
    }
}

export interface RuntimeConfig {
    readonly adapters: RuntimeAgentDependencies["adapters"];
    readonly agents: readonly CatalogAgent[];
    readonly defaultWorkspace: string;
    readonly bindingId: string;
    readonly catalog: LocalAgentCatalog;
    readonly channelId: string;
    readonly localContext: RuntimeLocalContext;
    readonly reconnectTarget: RuntimeReconnectTarget | null;
    readonly relayUrl: URL;
    /** Stable embedding context for one Session; applied to a copied Agent before process reuse is checked. */
    readonly sessionEnvironment?: (context: {
        readonly sessionId: string;
        readonly agentId: string;
    }) => Readonly<Record<string, string>>;
    /**
     * Serves the definition a command should run against, re-discoving the Agent when its
     * executable changed since the catalog snapshot was taken. Undefined keeps the boot-time
     * snapshot: a changed executable fails the command instead of being re-discovered.
     */
    readonly resolveAgent?: (agent: CatalogAgent, signal: AbortSignal) => Promise<CatalogAgent>;
    /**
     * Re-runs the ready Agent inventory this config was built from, serving the Agent catalog
     * discovery command. Undefined keeps the boot-time catalog: the command fails instead.
     */
    readonly rediscoverAgents?: (signal: AbortSignal) => Promise<readonly CatalogAgent[]>;
}

export interface RuntimeConnectionConfig {
    readonly defaultWorkspace: string;
    readonly channelId: string;
    readonly relayUrl: URL;
}

export function createRuntimeConfig(
    connection: RuntimeConnectionConfig,
    dependencies: RuntimeAgentDependencies,
    localContext: RuntimeLocalContext,
    reconnectTarget: RuntimeReconnectTarget | null = null,
    resolveAgent?: RuntimeConfig["resolveAgent"],
    rediscoverAgents?: RuntimeConfig["rediscoverAgents"],
): RuntimeConfig {
    const runtimeAgents = dependencies.agents.map((agent) =>
        withRuntimeEnvironment(agent, localContext.agentLaunchEnvironment),
    );
    return {
        adapters: dependencies.adapters,
        agents: runtimeAgents,
        defaultWorkspace: connection.defaultWorkspace,
        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
        catalog: new LocalAgentCatalog(runtimeAgents),
        channelId: connection.channelId,
        localContext,
        reconnectTarget,
        relayUrl: connection.relayUrl,
        ...(resolveAgent === undefined ? {} : { resolveAgent }),
        ...(rediscoverAgents === undefined ? {} : { rediscoverAgents }),
    };
}
