import { fetch } from "undici";

import type { DaemonConfig } from "../config.ts";
import { environmentProxyDispatcher } from "../network/environment-proxy.ts";

const CATALOG_UPDATE_TIMEOUT_MILLISECONDS = 20_000;

class AgentCatalogPublishError extends Error {
  readonly code = "agent_catalog_update_failed";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AgentCatalogPublishError";
  }
}

function catalogEndpoint(relayUrl: URL): URL {
  const endpoint = new URL(relayUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  if (!endpoint.pathname.endsWith("/daemon")) {
    throw new AgentCatalogPublishError("The Relay URL is invalid");
  }
  endpoint.pathname = `${endpoint.pathname.slice(0, -"/daemon".length)}/catalog`;
  return endpoint;
}

export async function publishAgentCatalog(
  config: DaemonConfig,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(
    CATALOG_UPDATE_TIMEOUT_MILLISECONDS,
  );
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  let response: Awaited<ReturnType<typeof fetch>>;
  const catalog = config.catalog.read();
  try {
    response = await fetch(catalogEndpoint(config.relayUrl), {
      body: JSON.stringify({
        agents: catalog.agents.map((agent) => ({
          agentPath: agent.agentIdentity.requestedPath,
          agentVersion: agent.agentVersion,
          id: agent.id,
          label: agent.label,
        })),
        installableAgents: catalog.installableAgents,
      }),
      dispatcher: environmentProxyDispatcher,
      headers: { "content-type": "application/json" },
      method: "PUT",
      signal: requestSignal,
    });
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    throw new AgentCatalogPublishError(
      timeoutSignal.aborted
        ? "The Agent catalog update timed out"
        : "The Agent catalog could not be updated",
      { cause: error },
    );
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new AgentCatalogPublishError(
      "The Relay rejected the Agent catalog update",
    );
  }
}
