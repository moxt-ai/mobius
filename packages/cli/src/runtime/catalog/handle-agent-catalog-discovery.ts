import {
    AGENT_CATALOG_DISCOVERY_FAILED_KIND,
    type AgentCatalogDiscoverCommand,
    type AgentCatalogDiscoveredEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import type { CatalogAgent } from "../../agent/catalog.ts";
import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { Timer } from "../../util/timer.ts";
import { send } from "../command/transport.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import { refreshAgentCatalog } from "./refresh-agent-catalog.ts";

interface CatalogDiscoveryDependencies {
    readonly config: RuntimeConfig;
    /** Re-runs the ready Agent inventory this daemon was started with. */
    readonly discover: (signal: AbortSignal) => Promise<readonly CatalogAgent[]>;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

const CATALOG_DISCOVERY_TIMEOUT_MILLISECONDS = 90_000;

function discoveredEvent(
    command: AgentCatalogDiscoverCommand,
    agents: readonly { readonly agentVersion: string; readonly id: string; readonly label: string }[],
): AgentCatalogDiscoveredEvent {
    return {
        agents: agents.map((agent) => ({
            agentVersion: agent.agentVersion,
            id: agent.id,
            label: agent.label,
        })),
        kind: "agent.catalog.discovered",
        requestId: command.requestId,
    };
}

/**
 * Handles the Relay's request to re-read the local Agent inventory: discovery runs against the
 * filesystem now, the catalog transitions to what this daemon could currently spawn, and the
 * result is republished so the Relay's stored snapshot stops serving the boot-time set. The
 * transition and publication commit through the same serialized critical section as the lazy
 * per-Agent resolver, so a failed publication rolls back to the snapshot this operation read
 * without overwriting a concurrent resolver swap. Concurrent requests share one discovery.
 */
export function createAgentCatalogDiscoveryHandler(dependencies: CatalogDiscoveryDependencies) {
    const { config, discover, diagnostics, socket, signal, timer } = dependencies;
    const requestIds = new Set<string>();
    let controller: AbortController | null = null;
    let completion: Promise<void> | null = null;

    const handle = (command: AgentCatalogDiscoverCommand): void => {
        if (requestIds.has(command.requestId) || controller !== null) {
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, {
                    code: "agent_catalog_discovery_busy",
                    kind: AGENT_CATALOG_DISCOVERY_FAILED_KIND,
                    message: "An Agent catalog discovery is already running",
                    requestId: command.requestId,
                });
            }
            return;
        }
        controller = new AbortController();
        requestIds.add(command.requestId);
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () => controller?.abort(new Error("Agent catalog discovery timed out")),
            CATALOG_DISCOVERY_TIMEOUT_MILLISECONDS,
        );
        completion = (async (): Promise<void> => {
            try {
                // The published snapshot answers the command: a concurrent resolver swap that
                // commits after this publication describes its own reply, not this one.
                const published = await refreshAgentCatalog(config, discover, operationSignal);
                operationSignal.throwIfAborted();
                if (socket.readyState === WebSocket.OPEN) {
                    send(
                        socket,
                        discoveredEvent(
                            command,
                            published.agents.map((agent) => ({
                                agentVersion: agent.agentVersion,
                                id: agent.id,
                                label: agent.label,
                            })),
                        ),
                    );
                }
            } catch (error) {
                diagnostics.daemonDiagnostic(
                    "agent_catalog_discovery_failed",
                    command.requestId,
                    { code: operationErrorCode(error) },
                    error,
                );
                if (socket.readyState === WebSocket.OPEN) {
                    send(socket, {
                        code: operationErrorCode(error),
                        kind: AGENT_CATALOG_DISCOVERY_FAILED_KIND,
                        message: operationErrorMessage(error),
                        requestId: command.requestId,
                    });
                }
            } finally {
                timeout.cancel();
                requestIds.delete(command.requestId);
                controller = null;
                completion = null;
            }
        })();
    };

    const settle = async (): Promise<void> => {
        await (completion ?? Promise.resolve());
    };

    return { handle, settle };
}
