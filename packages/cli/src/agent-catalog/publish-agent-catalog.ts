import { fetch } from "undici";

import type { DaemonConfig } from "../config.ts";
import { environmentProxyDispatcher } from "../network/environment-proxy.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "../relay-connection/runtime-authentication.ts";

const CATALOG_UPDATE_TIMEOUT_MILLISECONDS = 20_000;

class AgentCatalogPublishError extends Error {
    readonly code = "agent_catalog_update_failed";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "AgentCatalogPublishError";
    }
}

function catalogEndpoint(config: DaemonConfig): URL {
    const endpoint = relayHttpEndpoint(config.relayUrl);
    if (endpoint.pathname.endsWith("/daemon")) {
        endpoint.pathname = `${endpoint.pathname.slice(0, -"/daemon".length)}/catalog`;
        return endpoint;
    }
    const runtimePath = "/v1/runtimes/connect";
    if (endpoint.pathname.endsWith(runtimePath)) {
        endpoint.pathname = `${endpoint.pathname.slice(0, -runtimePath.length)}/channels/${encodeURIComponent(config.channelId)}/catalog`;
        return endpoint;
    }
    throw new AgentCatalogPublishError("The Relay URL is invalid");
}

export async function publishAgentCatalog(config: DaemonConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(CATALOG_UPDATE_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Awaited<ReturnType<typeof fetch>>;
    const catalog = config.catalog.read();
    try {
        response = await fetch(catalogEndpoint(config), {
            body: JSON.stringify({
                agents: catalog.agents.map((agent) => ({
                    agentPath: agent.agentIdentity.requestedPath,
                    agentVersion: agent.agentVersion,
                    agentSettingsDiscovery: true,
                    capabilities: agent.capabilities,
                    id: agent.id,
                    label: agent.label,
                    sessionTurnConfiguration: true,
                })),
                installableAgents: catalog.installableAgents,
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { ...runtimeAuthorization(config.relayUrl), "content-type": "application/json" },
            method: "PUT",
            signal: requestSignal,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        throw new AgentCatalogPublishError(
            timeoutSignal.aborted ? "The Agent catalog update timed out" : "The Agent catalog could not be updated",
            { cause: error },
        );
    }
    await response.body?.cancel();
    if (!response.ok) {
        throw new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
}
