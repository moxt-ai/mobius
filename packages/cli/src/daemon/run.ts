import { createHash } from "node:crypto";
import { join } from "node:path";
import { styleText } from "node:util";
import { harnessAdapters } from "../acp/adapter/registry.ts";
import { resolveMaxAcpProcesses } from "../acp/agent-process-pool.ts";
import { AgentRuntimeManager } from "../acp/agent-runtime-manager.ts";
import { CachedAcpSessionEventStore } from "../acp/session-event-store.ts";
import { SqliteAcpSessionStore } from "../acp/session-store.ts";
import { publishAgentCatalog } from "../agent-catalog/publish-agent-catalog.ts";
import { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { AcpContentExternalizer } from "../external-content/acp-content-externalizer.ts";
import { LocalExternalContentStore } from "../external-content/local-external-content-store.ts";
import { openAcpSessionDatabase, openSessionEventCacheDatabase } from "../local-databases.ts";
import { NativeSessionService } from "../native-sessions/service.ts";
import { DaemonSessionEventProjection } from "../session-event-projection.ts";
import { SqliteSessionLiveEventPosition } from "../session-live-event-position.ts";
import { DaemonAcpObserver } from "./acp-observer.ts";
import type { DaemonConfig } from "./config.ts";
import { DaemonDiagnosticLog } from "./observability/diagnostic-log.ts";
import { DaemonOperationState } from "./relay/daemon-operation-state.ts";
import { RelayConnectionDiagnostics } from "./relay/diagnostics.ts";
import { runRelayConnection } from "./relay/run-relay-connection.ts";
import { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
import { DaemonSessionEventPublisher } from "./relay/session-event-publisher.ts";
import { type DaemonTimer, systemDaemonTimer } from "./relay/timer.ts";
import { DaemonTurnRegistry } from "./turn-registry.ts";

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

export interface RunDaemonOptions {
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
}

export async function runDaemon(
    config: DaemonConfig,
    parentSignal: AbortSignal,
    timer: DaemonTimer = systemDaemonTimer,
    options: RunDaemonOptions = {},
): Promise<void> {
    const shutdown = new AbortController();
    const signal = AbortSignal.any([parentSignal, shutdown.signal]);
    const stateDirectory = config.localContext.stateDirectory;
    const channelHash = createHash("sha256").update(config.channelId).digest("hex");
    const sessionDatabase = openAcpSessionDatabase(join(stateDirectory, "sessions", `${channelHash}.sqlite`));
    let events: CachedAcpSessionEventStore;
    try {
        events = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(stateDirectory, "sessions", `${channelHash}.events.sqlite`)),
            new SqliteSessionLiveEventPosition(sessionDatabase),
        );
    } catch (error) {
        sessionDatabase.close();
        throw error;
    }
    const sessionStore = new SqliteAcpSessionStore(sessionDatabase, events);
    await using externalContent = new LocalExternalContentStore(stateDirectory);
    const operations = new DaemonOperationState();
    const publisher = new DaemonSessionEventPublisher(timer);
    const activeTurns = new DaemonTurnRegistry(operations);
    const eventProjection = new DaemonSessionEventProjection(
        publisher,
        (sessionId, event) => agentRuntime.recordLifecycleEvent(sessionId, event),
        activeTurns.recordSessionEvent,
    );
    const agentRuntime = new AgentRuntimeManager({
        observer: new DaemonAcpObserver(eventProjection.record, publisher.publishInfo),
        store: sessionStore,
        adapters: harnessAdapters,
        sessionIdentity: "native",
        onSessionStatusChanged: publisher.publishStatus,
        contentExternalizer: new AcpContentExternalizer(externalContent),
        timer,
        maxProcesses: resolveMaxAcpProcesses(config.localContext.environment),
    });
    const directories = new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace);
    const diagnostics = new RelayConnectionDiagnostics(
        config.channelId,
        config.relayUrl,
        new DaemonDiagnosticLog(stateDirectory),
    );
    const nativeSessions = new NativeSessionService(config, directories, agentRuntime, async (request, options) => {
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
                additionalDirectories.every((directory, index) => directory === options.additionalDirectories[index])
            );
        });
    });
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
    };
    const catalogPublication = publishAgentCatalogUntilAvailable(config, diagnostics, signal, timer);
    void catalogPublication.then(() => {
        if (signal.aborted) {
            return;
        }
        catalogPublished = true;
        announceReadiness();
    });

    try {
        while (!signal.aborted) {
            connectionEpoch += 1;
            try {
                await runRelayConnection({
                    config,
                    directories,
                    sessions: agentRuntime,
                    nativeSessions,
                    operations,
                    publisher,
                    eventProjection,
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
        shutdown.abort();
        await activeTurns.close();
        try {
            await catalogPublication;
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
