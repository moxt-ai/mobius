import {
    AGENT_CATALOG_REFRESH_FAILED_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    type AgentCatalogRefreshCommand,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import { AcpExecutionError } from "../acp/session-manager.ts";
import type { AuditStore } from "../audit/audit-store.ts";
import { type DaemonConfig, DaemonLocalContext, withDaemonEnvironment } from "../config.ts";
import { operationErrorCode, operationErrorMessage, send } from "../daemon-session-commands.ts";
import { revalidateExecutable } from "../process/executable.ts";
import type { RelayConnectionDiagnostics } from "../relay-connection/diagnostics.ts";
import type { DaemonTimer } from "../relay-connection/timer.ts";
import { discoverLocalAgentInventory } from "./discover-local-agents.ts";
import type { AcpAgentDefinition } from "./local-agent.ts";
import { publishAgentCatalog } from "./publish-agent-catalog.ts";

// A refresh observes the machine through executable discovery, which depends on ambient state such
// as PATH and the managed state directory. An Agent that was verified a moment ago is therefore not
// necessarily uninstalled just because one discovery attempt failed to re-verify it. Keep the last
// verified definition while the exact executable it was verified against still exists unchanged on
// disk, so a transient probe failure cannot silently drop a working Agent. A genuine removal, or a
// replaced executable, stops satisfying that check and is still reflected in the catalog.
async function retainStillInstalledAgents(
    previous: readonly AcpAgentDefinition[],
    refreshed: readonly AcpAgentDefinition[],
    signal: AbortSignal,
): Promise<readonly AcpAgentDefinition[]> {
    const refreshedIdentifiers = new Set(refreshed.map((agent) => agent.id));
    const retained: AcpAgentDefinition[] = [];
    for (const agent of previous) {
        if (refreshedIdentifiers.has(agent.id)) {
            continue;
        }
        signal.throwIfAborted();
        if (await revalidateExecutable(agent.agentIdentity)) {
            retained.push(agent);
        }
    }
    return Object.freeze([...refreshed, ...retained]);
}

async function refreshAgentCatalog(
    config: DaemonConfig,
    resolveEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const shellEnvironment = await resolveEnvironment(signal);
    const environment = new DaemonLocalContext(config.localContext.stateDirectory, shellEnvironment).environment;
    signal.throwIfAborted();
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: config.defaultWorkspace,
        environment,
        signal,
    });
    const previousCatalog = config.catalog.read();
    const refreshedAgents = inventory.readyAgents().map((agent) => withDaemonEnvironment(agent, environment));
    const agents = await retainStillInstalledAgents(previousCatalog.agents, refreshedAgents, signal);
    const verifiedIdentifiers = new Set(agents.map((agent) => agent.id));
    config.catalog.transition(
        agents,
        inventory.installable.filter((agent) => !verifiedIdentifiers.has(agent.id)),
    );
    try {
        await publishAgentCatalog(config, signal);
    } catch (error) {
        config.catalog.transition(previousCatalog.agents, previousCatalog.installableAgents);
        throw error;
    }
}

interface CatalogRefreshDependencies {
    readonly config: DaemonConfig;
    readonly audit: AuditStore;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: DaemonTimer;
    readonly resolveEnvironment: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>;
}

export function createAgentCatalogRefreshHandler(dependencies: CatalogRefreshDependencies) {
    const { config, audit, diagnostics, socket, signal, timer, resolveEnvironment } = dependencies;
    const agentCatalogRefreshes = new Map<
        string,
        {
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const handle = (command: AgentCatalogRefreshCommand): void => {
        if (agentCatalogRefreshes.has(command.requestId) || agentCatalogRefreshes.size > 0) {
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, {
                    code: "agent_catalog_refresh_busy",
                    kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                    message: "Another local Agent catalog refresh is already running",
                    requestId: command.requestId,
                });
            }
            return;
        }
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () =>
                controller.abort(
                    new AcpExecutionError(
                        "The local Agent catalog refresh timed out",
                        {},
                        "agent_catalog_refresh_timeout",
                    ),
                ),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                await refreshAgentCatalog(config, resolveEnvironment, operationSignal);
                audit.record({
                    commandId: command.requestId,
                    event: "agent_catalog_refreshed",
                    sessionId: "agent-catalog",
                });
                if (socket.readyState === WebSocket.OPEN) {
                    send(socket, {
                        kind: AGENT_CATALOG_REFRESHED_KIND,
                        requestId: command.requestId,
                    });
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new AcpExecutionError(
                          "The local Agent catalog refresh was cancelled",
                          {},
                          "agent_catalog_refresh_cancelled",
                      ))
                    : error;
                audit.record({
                    commandId: command.requestId,
                    details: { code: operationErrorCode(failure) },
                    event: "agent_catalog_refresh_failed",
                    sessionId: "agent-catalog",
                });
                diagnostics.daemonDiagnostic(
                    "agent_catalog_refresh_failed",
                    command.requestId,
                    { code: operationErrorCode(failure) },
                    failure,
                );
                if (socket.readyState === WebSocket.OPEN) {
                    send(socket, {
                        code: operationErrorCode(failure),
                        kind: AGENT_CATALOG_REFRESH_FAILED_KIND,
                        message: operationErrorMessage(failure),
                        requestId: command.requestId,
                    });
                }
            } finally {
                timeout.cancel();
                agentCatalogRefreshes.delete(command.requestId);
            }
        })();
        agentCatalogRefreshes.set(command.requestId, { completion, controller });
        return;
    };
    const settle = async (): Promise<void> => {
        await Promise.all([...agentCatalogRefreshes.values()].map((request) => request.completion));
    };
    return { handle, settle };
}
