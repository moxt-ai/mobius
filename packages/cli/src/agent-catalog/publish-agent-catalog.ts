import { fetch } from "undici";

import type { DaemonConfig } from "../config.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "../relay-connection/runtime-authentication.ts";
import { environmentProxyDispatcher } from "../util/network/environment-proxy.ts";

const CATALOG_UPDATE_TIMEOUT_MILLISECONDS = 20_000;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

class AgentCatalogPublishError extends Error {
    readonly code = "agent_catalog_update_failed";
    readonly diagnosticDetails: Readonly<Record<string, string>>;

    constructor(message: string, options: ErrorOptions = {}, diagnosticDetails: Readonly<Record<string, string>> = {}) {
        super(message, options);
        this.diagnosticDetails = diagnosticDetails;
        this.name = "AgentCatalogPublishError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelayErrorMessage(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= 512 &&
        Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    );
}

async function rejectedCatalogError(response: FetchResponse): Promise<AgentCatalogPublishError> {
    let value: unknown;
    try {
        value = await response.json();
    } catch {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    if (!isRecord(value) || !isRecord(value["error"])) {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    const code = value["error"]["code"];
    const message = value["error"]["message"];
    if (
        typeof code !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(code) ||
        typeof message !== "string" ||
        !isSafeRelayErrorMessage(message)
    ) {
        return new AgentCatalogPublishError("The Relay rejected the Agent catalog update");
    }
    return new AgentCatalogPublishError(
        `The Relay rejected the Agent catalog update (${code}): ${message}`,
        {},
        {
            relayErrorCode: code,
        },
    );
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
    let response: FetchResponse;
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
    if (!response.ok) {
        throw await rejectedCatalogError(response);
    }
    await response.body?.cancel();
}
