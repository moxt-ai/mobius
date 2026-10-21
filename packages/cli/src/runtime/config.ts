import { join, resolve } from "node:path";
import { mobiusApiPath, RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-sdk/protocol";
import { type AcpAgentDefinition, LocalAgentCatalog } from "../agent-catalog/local-agent.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

export type { AcpAgentDefinition } from "../agent-catalog/local-agent.ts";
export { InProcessAcpAgentDefinition, LocalAgentDefinition } from "../agent-catalog/local-agent.ts";

export function loadDefaultWorkspace(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    const { MOBIUS_DEFAULT_WORKSPACE: configuredWorkspace } = environment;
    return configuredWorkspace ?? join(readStateDirectory(environment), "workspace");
}

export class RuntimeLocalContext {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;

    constructor(stateDirectory: string, environment: Readonly<NodeJS.ProcessEnv> = process.env) {
        this.stateDirectory = resolve(stateDirectory);
        this.environment = Object.freeze({ ...environment, MOBIUS_STATE_DIRECTORY: this.stateDirectory });
    }
}

export function withRuntimeEnvironment(
    agent: AcpAgentDefinition,
    environment: Readonly<NodeJS.ProcessEnv>,
): AcpAgentDefinition {
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
    readonly agents: readonly AcpAgentDefinition[];
    readonly defaultWorkspace: string;
    readonly bindingId: string;
    readonly catalog: LocalAgentCatalog;
    readonly channelId: string;
    readonly localContext: RuntimeLocalContext;
    readonly reconnectTarget: RuntimeReconnectTarget | null;
    readonly relayUrl: URL;
    /**
     * Serves the definition a command should run against, re-discoving the Agent when its
     * executable changed since the catalog snapshot was taken. Undefined keeps the boot-time
     * snapshot: a changed executable fails the command instead of being re-discovered.
     */
    readonly resolveAgent?: (agent: AcpAgentDefinition, signal: AbortSignal) => Promise<AcpAgentDefinition>;
}

export interface RuntimeConnectionConfig {
    readonly defaultWorkspace: string;
    readonly channelId: string;
    readonly relayUrl: URL;
}

export function createRuntimeConfig(
    connection: RuntimeConnectionConfig,
    agents: readonly AcpAgentDefinition[] = [],
    localContext: RuntimeLocalContext = new RuntimeLocalContext(readStateDirectory(), process.env),
    reconnectTarget: RuntimeReconnectTarget | null = null,
    resolveAgent?: RuntimeConfig["resolveAgent"],
): RuntimeConfig {
    const runtimeAgents = agents.map((agent) => withRuntimeEnvironment(agent, localContext.environment));
    return {
        agents: runtimeAgents,
        defaultWorkspace: connection.defaultWorkspace,
        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
        catalog: new LocalAgentCatalog(runtimeAgents),
        channelId: connection.channelId,
        localContext,
        reconnectTarget,
        relayUrl: connection.relayUrl,
        ...(resolveAgent === undefined ? {} : { resolveAgent }),
    };
}

export function loadRuntimeConfig(): RuntimeConfig {
    const relayUrl = new URL(
        process.env["MOBIUS_RELAY_URL"] ?? `ws://127.0.0.1:8787${mobiusApiPath("/channels/local/daemon")}`,
    );
    relayUrl.searchParams.set("token", process.env["MOBIUS_RELAY_TOKEN"] ?? "local-development-token");

    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new Error("MOBIUS_RELAY_URL must use ws or wss");
    }

    return createRuntimeConfig(
        {
            defaultWorkspace: loadDefaultWorkspace(),
            channelId: process.env["MOBIUS_CHANNEL_ID"] ?? "local",
            relayUrl,
        },
        [],
    );
}
