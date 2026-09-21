import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mobiusApiPath } from "@moxt-ai/mobius-protocol";
import {
    type AcpAgentDefinition,
    type InstallableAgentDefinition,
    LocalAgentCatalog,
} from "./agent-catalog/local-agent.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

export type { AcpAgentDefinition } from "./agent-catalog/local-agent.ts";
export { LocalAgentDefinition } from "./agent-catalog/local-agent.ts";

export function loadDefaultWorkspace(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    const { MOBIUS_DEFAULT_WORKSPACE: configuredWorkspace } = environment;
    return configuredWorkspace ?? join(readStateDirectory(environment), "workspace");
}

export class DaemonLocalContext {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;

    constructor(stateDirectory: string, environment: Readonly<NodeJS.ProcessEnv> = process.env) {
        this.stateDirectory = resolve(stateDirectory);
        this.environment = Object.freeze({ ...environment, MOBIUS_STATE_DIRECTORY: this.stateDirectory });
    }
}

export function withDaemonEnvironment(
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

export abstract class DaemonReconnectTarget {
    abstract readonly commandArgument: string;
}

export class OpaqueDaemonReconnectTarget extends DaemonReconnectTarget {
    readonly connectionId: string;
    readonly commandArgument: string;

    constructor(connectionId: string) {
        super();
        this.connectionId = connectionId;
        this.commandArgument = `--connection ${connectionId}`;
    }
}

export class ChannelDaemonReconnectTarget extends DaemonReconnectTarget {
    readonly channelId: string;
    readonly commandArgument: string;

    constructor(channelId: string) {
        super();
        this.channelId = channelId;
        this.commandArgument = `--channel ${channelId}`;
    }
}

export interface DaemonConfig {
    readonly agents: readonly AcpAgentDefinition[];
    readonly defaultWorkspace: string;
    readonly auditDatabasePath: string;
    readonly bindingId: string;
    readonly catalog: LocalAgentCatalog;
    readonly channelId: string;
    readonly installableAgents: readonly InstallableAgentDefinition[];
    readonly localContext: DaemonLocalContext;
    readonly reconnectTarget: DaemonReconnectTarget;
    readonly relayUrl: URL;
}

export interface DaemonConnectionConfig {
    readonly defaultWorkspace: string;
    readonly auditDatabasePath: string;
    readonly channelId: string;
    readonly relayUrl: URL;
}

export function createDaemonConfig(
    connection: DaemonConnectionConfig,
    agents: readonly AcpAgentDefinition[] = [],
    installableAgents: readonly InstallableAgentDefinition[] = [],
    localContext: DaemonLocalContext = new DaemonLocalContext(readStateDirectory(), process.env),
    reconnectTarget: DaemonReconnectTarget = new ChannelDaemonReconnectTarget(connection.channelId),
): DaemonConfig {
    const daemonAgents = agents.map((agent) => withDaemonEnvironment(agent, localContext.environment));
    return {
        agents: daemonAgents,
        defaultWorkspace: connection.defaultWorkspace,
        auditDatabasePath: connection.auditDatabasePath,
        bindingId: "workspace",
        catalog: new LocalAgentCatalog(daemonAgents, installableAgents),
        channelId: connection.channelId,
        installableAgents,
        localContext,
        reconnectTarget,
        relayUrl: connection.relayUrl,
    };
}

export function loadDaemonConfig(): DaemonConfig {
    const relayUrl = new URL(
        process.env["MOBIUS_RELAY_URL"] ?? `ws://127.0.0.1:8787${mobiusApiPath("/channels/local/daemon")}`,
    );
    relayUrl.searchParams.set("token", process.env["MOBIUS_RELAY_TOKEN"] ?? "local-development-token");

    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new Error("MOBIUS_RELAY_URL must use ws or wss");
    }

    return createDaemonConfig(
        {
            defaultWorkspace: loadDefaultWorkspace(),
            auditDatabasePath:
                process.env["MOBIUS_AUDIT_DATABASE"] ??
                fileURLToPath(new URL("../../../.mobius/daemon.sqlite", import.meta.url)),
            channelId: process.env["MOBIUS_CHANNEL_ID"] ?? "local",
            relayUrl,
        },
        [],
        [],
    );
}
