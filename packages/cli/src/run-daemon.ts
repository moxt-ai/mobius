import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { styleText } from "node:util";

import { AGENT_INSTALL_REQUEST_KIND } from "@moxt-ai/mobius-protocol";

import { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import { CachedAcpSessionEventStoreV2 } from "./acp/session-event-store-v2.ts";
import { SqliteAcpSessionStore } from "./acp/session-store.ts";
import { supportedLocalAgentSpecifications } from "./agent-catalog/discover-local-agents.ts";
import { AgentIntegrationDefinition } from "./agent-catalog/local-agent.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import { AgentInstallationManager } from "./agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "./agent-installation/fixed-installation-executor.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { DaemonDiagnosticLog } from "./daemon-diagnostic-log.ts";
import { AuditInstallationEvents, DaemonAcpObserver, DaemonInstallationObserver } from "./daemon-observers.ts";
import { DaemonTurnRegistry } from "./daemon-turn-registry.ts";
import { AcpContentExternalizer } from "./external-content/acp-content-externalizer.ts";
import { LocalExternalContentStore } from "./external-content/local-external-content-store.ts";
import { openAcpSessionDatabase, openSessionEventCacheV2Database } from "./local-databases.ts";
import { readCodexFullHistory } from "./native-sessions/codex-history.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { DaemonOperationState } from "./relay-connection/daemon-operation-state.ts";
import { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import { runRelayConnection } from "./relay-connection/run-relay-connection.ts";
import { RuntimeRelayRevokedError } from "./relay-connection/runtime-revocation.ts";
import { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";
import { type DaemonTimer, systemDaemonTimer } from "./relay-connection/timer.ts";
import { DaemonSessionEventLogV2 } from "./session-event-log-v2.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;

function waitForRelayRetry(signal: AbortSignal, timer: DaemonTimer): Promise<void> {
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
    config: DaemonConfig,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
    timer: DaemonTimer,
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

async function installDetectedAgentIntegrations(
    config: DaemonConfig,
    installations: AgentInstallationManager,
    signal: AbortSignal,
): Promise<void> {
    for (const agent of config.catalog.read().installableAgents) {
        if (!(agent instanceof AgentIntegrationDefinition)) {
            continue;
        }
        signal.throwIfAborted();
        await installations.request(
            {
                agentId: agent.id,
                kind: AGENT_INSTALL_REQUEST_KIND,
                requestId: `automatic-integration-${randomUUID()}`,
            },
            signal,
        );
    }
}

export interface RunDaemonOptions {
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
}

export async function runDaemon(
    config: DaemonConfig,
    audit: AuditStore,
    signal: AbortSignal,
    timer: DaemonTimer = systemDaemonTimer,
    options: RunDaemonOptions = {},
): Promise<void> {
    const installationAudit = new AuditInstallationEvents(audit);
    const stateDirectory = config.localContext.stateDirectory;
    const specifications = supportedLocalAgentSpecifications();
    const installationExecutor = new FixedInstallationExecutor({
        defaultWorkspace: config.defaultWorkspace,
        audit: installationAudit,
        catalog: config.catalog,
        environment: config.localContext.environment,
        publishCatalog: async (installationSignal) => await publishAgentCatalog(config, installationSignal),
        stateDirectory,
    });
    const channelHash = createHash("sha256").update(config.channelId).digest("hex");
    const sessionDatabase = openAcpSessionDatabase(join(stateDirectory, "sessions", `${channelHash}.sqlite`));
    let eventsV2: CachedAcpSessionEventStoreV2;
    try {
        eventsV2 = new CachedAcpSessionEventStoreV2(
            openSessionEventCacheV2Database(join(stateDirectory, "sessions", `${channelHash}.events.sqlite`)),
        );
    } catch (error) {
        sessionDatabase.close();
        throw error;
    }
    const sessionStore = new SqliteAcpSessionStore(sessionDatabase, eventsV2);
    await using externalContent = new LocalExternalContentStore(stateDirectory);
    const operations = new DaemonOperationState();
    const publisher = new DaemonSessionEventPublisher(timer);
    const eventLogV2 = new DaemonSessionEventLogV2(publisher, (sessionId, event) =>
        agentRuntime.recordLifecycleEventV2(sessionId, event),
    );
    const activeTurns = new DaemonTurnRegistry(operations);
    const agentRuntime = new AgentRuntimeManager(
        new DaemonAcpObserver((_sessionId, event) => {
            activeTurns.recordEvent(event);
            if (event.kind === "session.info.updated") {
                publisher.publishInfo(event);
            }
        }, eventLogV2.record),
        sessionStore,
        {
            access: (options) =>
                options.agent.id === "codex"
                    ? {
                          kind: "direct",
                          read: async (nativeSessionId, nativeTurn) =>
                              (
                                  await readCodexFullHistory(
                                      options.agent,
                                      options.cwd,
                                      nativeSessionId,
                                      options.signal,
                                      nativeTurn,
                                  )
                              ).history,
                      }
                    : { kind: "acp" },
        },
        "native",
        publisher.publishStatus,
        new AcpContentExternalizer(externalContent),
    );
    const directories = new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace);
    const installationObserver = new DaemonInstallationObserver();
    const diagnostics = new RelayConnectionDiagnostics(
        audit,
        config.channelId,
        config.relayUrl,
        new DaemonDiagnosticLog(stateDirectory),
    );
    const nativeSessions = new NativeSessionService(
        config,
        directories,
        agentRuntime,
        audit,
        async (request, options) => {
            return await activeTurns.executionSnapshot(async (command) => {
                if (command.sessionId !== request.targetSessionId || command.agentId !== request.agentId) {
                    return false;
                }
                const cwd = await directories.resolve(command.bindingId, command.directoryId, options.signal);
                const additionalDirectories = await directories.resolveMany(
                    command.bindingId,
                    command.additionalDirectoryIds,
                    options.signal,
                );
                return (
                    cwd === options.cwd &&
                    additionalDirectories.length === options.additionalDirectories.length &&
                    additionalDirectories.every(
                        (directory, index) => directory === options.additionalDirectories[index],
                    )
                );
            });
        },
    );
    const installations = new AgentInstallationManager(
        specifications,
        installationExecutor,
        installationObserver,
        installationAudit,
    );
    let connectionEpoch = 0;
    let automaticIntegrationProvisioningStarted = false;
    let automaticIntegrationProvisioning = Promise.resolve();
    let connectionAnnounced = false;
    let catalogPublished = false;
    let readinessAnnounced = false;
    const startAutomaticIntegrationProvisioning = (): void => {
        if (!connectionAnnounced || !catalogPublished || automaticIntegrationProvisioningStarted) {
            return;
        }
        automaticIntegrationProvisioningStarted = true;
        automaticIntegrationProvisioning = installDetectedAgentIntegrations(config, installations, signal).catch(
            (error: unknown) => {
                if (!signal.aborted) {
                    console.error("Mobius daemon could not automatically install detected Agent integrations", error);
                }
            },
        );
    };
    const announceReadiness = (): void => {
        if (!connectionAnnounced || !catalogPublished) {
            return;
        }
        options.onConnectionStatus?.("online");
        if (readinessAnnounced) {
            return;
        }
        readinessAnnounced = true;
        process.stdout.write("Mobius daemon is ready for Agent requests.\n");
    };
    const announceConnection = (): void => {
        if (connectionAnnounced) {
            return;
        }
        connectionAnnounced = true;
        process.stdout.write("Mobius daemon connected to the relay.\n\n");
        if (config.reconnectTarget !== null) {
            const reconnectCommand = `mobius start ${config.reconnectTarget.commandArgument}`;
            process.stdout.write(
                `${styleText(["bold", "yellow"], `Reconnect this local connection later:\n  ${reconnectCommand}`)}\n\n`,
            );
        }
        announceReadiness();
        startAutomaticIntegrationProvisioning();
    };
    const catalogPublication = publishAgentCatalogUntilAvailable(config, diagnostics, signal, timer);
    void catalogPublication.then(() => {
        if (signal.aborted) {
            return;
        }
        catalogPublished = true;
        announceReadiness();
        startAutomaticIntegrationProvisioning();
    });

    try {
        while (!signal.aborted) {
            connectionEpoch += 1;
            try {
                await runRelayConnection({
                    config,
                    directories,
                    audit,
                    sessions: agentRuntime,
                    installations,
                    installationObserver,
                    nativeSessions,
                    operations,
                    publisher,
                    eventLogV2,
                    externalContent,
                    activeTurns,
                    connectionEpoch,
                    diagnostics,
                    onConnected: () => {
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
        await activeTurns.close();
        try {
            await catalogPublication;
        } finally {
            try {
                await automaticIntegrationProvisioning;
            } finally {
                try {
                    await installations.close();
                } finally {
                    try {
                        await agentRuntime.close();
                    } finally {
                        try {
                            sessionStore.close();
                        } finally {
                            try {
                                publisher.close();
                            } finally {
                                operations.close();
                            }
                        }
                    }
                }
            }
        }
    }
}
