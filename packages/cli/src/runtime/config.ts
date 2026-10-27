import { join, resolve } from "node:path";
import { RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-sdk/protocol";
import type { CatalogAgent } from "../agent/catalog.ts";
import { LocalAgentCatalog } from "../agent/catalog.ts";
import { RuntimeAgentDependencies } from "../agent/runtime-agents.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

/** The workspace new conversations use: `MOBIUS_DEFAULT_WORKSPACE`, or `workspace` in the Runtime's data directory. */
export function loadDefaultWorkspace(
    dataDirectory: string,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
    const { MOBIUS_DEFAULT_WORKSPACE: configuredWorkspace } = environment;
    return configuredWorkspace ?? join(dataDirectory, "workspace");
}

/**
 * Where a Runtime keeps its local data, and the environment it runs and launches Agents with. The data directory is
 * passed explicitly: the environment keeps the caller's MOBIUS_STATE_DIRECTORY, which names the CLI state root, so
 * Mobius run from an Agent addresses the same root as Mobius outside it.
 */
export class RuntimeLocalContext {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;

    constructor(stateDirectory: string, environment: Readonly<NodeJS.ProcessEnv> = process.env) {
        this.stateDirectory = resolve(stateDirectory);
        this.environment = Object.freeze({ ...environment });
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
    dependencies: RuntimeAgentDependencies = new RuntimeAgentDependencies([]),
    localContext: RuntimeLocalContext = new RuntimeLocalContext(readStateDirectory(), process.env),
    reconnectTarget: RuntimeReconnectTarget | null = null,
    resolveAgent?: RuntimeConfig["resolveAgent"],
    rediscoverAgents?: RuntimeConfig["rediscoverAgents"],
): RuntimeConfig {
    const runtimeAgents = dependencies.agents.map((agent) => withRuntimeEnvironment(agent, localContext.environment));
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
