import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mobiusApiPath } from "@moxt-ai/mobius-protocol";
import {
    type InstallableAgentDefinition,
    LocalAgentCatalog,
    type LocalAgentDefinition,
} from "./agent-catalog/local-agent.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

export { LocalAgentDefinition } from "./agent-catalog/local-agent.ts";

export function loadDefaultWorkspace(): string {
    const { MOBIUS_DEFAULT_WORKSPACE: configuredWorkspace } = process.env;
    return configuredWorkspace ?? join(readStateDirectory(), "workspace");
}

export interface DaemonConfig {
    readonly agents: readonly LocalAgentDefinition[];
    readonly defaultWorkspace: string;
    readonly auditDatabasePath: string;
    readonly bindingId: string;
    readonly catalog: LocalAgentCatalog;
    readonly channelId: string;
    readonly installableAgents: readonly InstallableAgentDefinition[];
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
    agents: readonly LocalAgentDefinition[] = [],
    installableAgents: readonly InstallableAgentDefinition[] = [],
): DaemonConfig {
    return {
        agents,
        defaultWorkspace: connection.defaultWorkspace,
        auditDatabasePath: connection.auditDatabasePath,
        bindingId: "workspace",
        catalog: new LocalAgentCatalog(agents, installableAgents),
        channelId: connection.channelId,
        installableAgents,
        relayUrl: connection.relayUrl,
    };
}

export function loadDaemonConfig(): DaemonConfig {
    const relayUrl = new URL(
        // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
        process.env["MOBIUS_RELAY_URL"] ?? `ws://127.0.0.1:8787${mobiusApiPath("/channels/local/daemon")}`,
    );
    relayUrl.searchParams.set(
        "token",
        // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
        process.env["MOBIUS_RELAY_TOKEN"] ?? "local-development-token",
    );

    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new Error("MOBIUS_RELAY_URL must use ws or wss");
    }

    return createDaemonConfig(
        {
            defaultWorkspace: loadDefaultWorkspace(),
            auditDatabasePath:
                // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
                process.env["MOBIUS_AUDIT_DATABASE"] ??
                fileURLToPath(new URL("../../../.mobius/daemon.sqlite", import.meta.url)),
            // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
            channelId: process.env["MOBIUS_CHANNEL_ID"] ?? "local",
            relayUrl,
        },
        [],
        [],
    );
}
