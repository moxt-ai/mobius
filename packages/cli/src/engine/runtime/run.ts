import { styleText } from "node:util";
import type { RuntimeUpgradeResult } from "@moxt-ai/mobius-sdk/protocol";
import { createRuntimeAdapterRegistry } from "../agent/runtime-agents.ts";
import { buildSessionLayer } from "../session/api/session-layer.ts";
import { LocalExternalContentStore } from "../session/content/external-content-store.ts";
import { AgentProcessPool } from "../session/process/agent-process-pool.ts";
import type { RuntimeAgentProcesses } from "../session/process/runtime-agent-processes.ts";
import type { RuntimeTurnActivity } from "../session/turn/runtime-turn-activity.ts";
import { runCleanup } from "../util/run-cleanup.ts";
import { systemTimer, type Timer } from "../util/timer.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { resolveCatalogAgent } from "./catalog/resolve-catalog-agent.ts";
import type { RuntimeConfig } from "./config.ts";
import { RuntimeDiagnosticLog } from "./observability/diagnostic-log.ts";
import { RelayConnectionDiagnostics } from "./relay/diagnostics.ts";
import { runRelayConnection } from "./relay/run-relay-connection.ts";
import { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
import { RuntimeSessionEventPublisher } from "./relay/session-event-publisher.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;
const defaultReportUpgradeAvailability = (): Promise<void> => Promise.resolve();

function waitForRelayRetry(signal: AbortSignal, timer: Timer): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const retry = timer.schedule(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

        function finish(): void {
            retry.cancel();
            signal.removeEventListener("abort", finish);
            resolve();
        }

        signal.addEventListener("abort", finish, { once: true });
    });
}

async function publishAgentCatalogUntilAvailable(
    config: RuntimeConfig,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
    timer: Timer,
): Promise<void> {
    try {
        await publishAgentCatalog(config, signal);
        return;
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        diagnostics.catalogFailed(error);
    }

    while (!signal.aborted) {
        await waitForRelayRetry(signal, timer);
        try {
            await publishAgentCatalog(config, signal);
            return;
        } catch {
            if (signal.aborted) {
                return;
            }
        }
    }
}

export interface RunRuntimeOptions {
    readonly turnActivity?: RuntimeTurnActivity;
    /** The daemon worker's registry of Runtime process pools, for releasing idle Agent processes on request. */
    readonly agentProcesses?: RuntimeAgentProcesses;
    readonly onExecutionCountChange?: (count: number) => void;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    /** Reports a finished daemon upgrade to the relay. The daemon worker supplies it. */
    readonly reportUpgradeAvailability?: (
        send: (result: RuntimeUpgradeResult) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    /**
     * State directory of the daemon processes supervising this Runtime. Their
     * lifecycle and rejection logs are the only witness of a silent worker death,
     * so the local bug-report log reads them too. Never written from here.
     */
    readonly processLogsDirectory?: string;
}

export async function runRuntime(
    config: RuntimeConfig,
    parentSignal: AbortSignal,
    timer: Timer = systemTimer,
    options: RunRuntimeOptions = {},
): Promise<void> {
    const { reportUpgradeAvailability = defaultReportUpgradeAvailability } = options;
    const shutdown = new AbortController();
    const signal = AbortSignal.any([parentSignal, shutdown.signal]);
    const stateDirectory = config.localContext.stateDirectory;
    const diagnostics = new RelayConnectionDiagnostics(
        config.channelId,
        config.relayUrl,
        new RuntimeDiagnosticLog(stateDirectory, {
            ...(options.processLogsDirectory === undefined
                ? {}
                : { processLogsDirectory: options.processLogsDirectory }),
        }),
    );
    const publisher = new RuntimeSessionEventPublisher(timer);
    // Dispose media only after session and adapter operations have drained.
    await using externalContent = new LocalExternalContentStore(stateDirectory);
    const processes = new AgentProcessPool(config.localContext.maxAcpProcesses, timer);
    const { adapters, externalizeSessionUpdate } = createRuntimeAdapterRegistry(
        config.adapters,
        processes,
        (sessionId, content, contentSignal) => externalContent.put({ ...content, sessionId, signal: contentSignal }),
        externalContent.linkedResources,
    );
    const resolveAgent = async (agentId: string, resolveSignal: AbortSignal, sessionId?: string) => {
        const catalogAgent = await resolveCatalogAgent(config, agentId, resolveSignal);
        const environment = sessionId === undefined ? undefined : config.sessionEnvironment?.({ sessionId, agentId });
        const agent =
            environment === undefined
                ? catalogAgent
                : catalogAgent.withEnvironment({ ...catalogAgent.environment, ...environment });
        return {
            agent,
            adapter: adapters.resolve(catalogAgent),
            externalizeSessionUpdate,
        };
    };
    const layer = buildSessionLayer({
        processes,
        ...(options.turnActivity === undefined ? {} : { turnActivity: options.turnActivity }),
        bindingId: config.bindingId,
        channelId: config.channelId,
        defaultWorkspace: config.defaultWorkspace,
        resolveAgent,
        sink: publisher,
        stateDirectory: config.localContext.stateDirectory,
        timer,
        onExecutionCountChange: options.onExecutionCountChange ?? (() => undefined),
    });
    const {
        activeSessions,
        directories,
        eventProjection,
        manager: agentRuntime,
        nativeSessions,
        operations,
        sessionStore,
    } = layer;
    let connectionEpoch = 0;
    let connectionAnnounced = false;
    let catalogPublished = false;
    let readinessAnnounced = false;
    const announceReadiness = (): void => {
        if (!connectionAnnounced || !catalogPublished) {
            return;
        }
        options.onConnectionStatus?.("online");
        if (readinessAnnounced) {
            return;
        }
        readinessAnnounced = true;
        process.stdout.write("Mobius Runtime is ready for Agent requests.\n");
    };
    const announceConnection = (): void => {
        if (connectionAnnounced) {
            return;
        }
        connectionAnnounced = true;
        process.stdout.write("Mobius Runtime connected to the relay.\n\n");
        if (config.reconnectTarget !== null) {
            const reconnectCommand = `mobius start ${config.reconnectTarget.commandArgument}`;
            process.stdout.write(
                `${styleText(["bold", "yellow"], `Reconnect this local connection later:\n  ${reconnectCommand}`)}\n\n`,
            );
        }
        announceReadiness();
    };
    const catalogPublication = publishAgentCatalogUntilAvailable(config, diagnostics, signal, timer);
    void catalogPublication.then(() => {
        if (signal.aborted) {
            return;
        }
        catalogPublished = true;
        announceReadiness();
    });

    const removeAgentProcesses = options.agentProcesses?.add(processes);
    try {
        while (!signal.aborted) {
            connectionEpoch += 1;
            try {
                await runRelayConnection({
                    config,
                    resolveAgent,
                    directories,
                    sessions: agentRuntime,
                    nativeSessions,
                    operations,
                    publisher,
                    eventProjection,
                    externalContent,
                    sessionTurns: activeSessions,
                    connectionEpoch,
                    reportUpgradeAvailability,
                    diagnostics,
                    onConnected: () => {
                        layer.publishRecoveredOutcomes();
                        if (catalogPublished) {
                            options.onConnectionStatus?.("online");
                        }
                        announceConnection();
                    },
                    signal,
                    timer,
                });
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                if (error instanceof RuntimeRelayRevokedError) {
                    throw error;
                }
                diagnostics.connectionFailed(connectionEpoch, error, "connection");
            }

            options.onConnectionStatus?.("reconnecting");
            await waitForRelayRetry(signal, timer);
        }
    } finally {
        removeAgentProcesses?.();
        shutdown.abort();
        operations.beginShutdown();
        await activeSessions.close();
        await runCleanup(
            () => catalogPublication,
            () => nativeSessions.close(),
            () => agentRuntime.close(),
            () => adapters.close(),
            () => sessionStore.close(),
            () => publisher.close(),
            () => operations.close(),
        );
    }
}
