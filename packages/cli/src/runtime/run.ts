import { createHash } from "node:crypto";
import { join } from "node:path";
import { styleText } from "node:util";
import { harnessAdapters } from "../acp/adapter/registry.ts";
import { resolveMaxAcpProcesses } from "../acp/agent-process-pool.ts";
import { AgentRuntimeManager } from "../acp/agent-runtime-manager.ts";
import { AcpContentExternalizer } from "../acp/external-content/acp-content-externalizer.ts";
import { LocalExternalContentStore } from "../acp/external-content/local-external-content-store.ts";
import { CachedAcpSessionEventStore } from "../acp/session-event-store.ts";
import { SqliteSessionLiveEventPosition } from "../acp/session-live-event-position.ts";
import { SqliteAcpSessionStore } from "../acp/session-store.ts";
import { openAcpSessionDatabase, openSessionEventCacheDatabase } from "../storage/local-databases.ts";
import { RuntimeAcpObserver } from "./acp-observer.ts";
import { RuntimeOperationState } from "./admission.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import type { RuntimeConfig } from "./config.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { RuntimeDiagnosticLog } from "./observability/diagnostic-log.ts";
import { RelayConnectionDiagnostics } from "./relay/diagnostics.ts";
import { runRelayConnection } from "./relay/run-relay-connection.ts";
import { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
import { RuntimeSessionEventPublisher } from "./relay/session-event-publisher.ts";
import { systemTimer, type Timer } from "./relay/timer.ts";
import { RuntimeSessionEventProjection } from "./session/session-event-projection.ts";
import { RuntimeSessions } from "./sessions.ts";
import { WorkspaceDirectoryService } from "./workspace/workspace-directory.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;

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
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
}

export async function runRuntime(
    config: RuntimeConfig,
    parentSignal: AbortSignal,
    timer: Timer = systemTimer,
    options: RunRuntimeOptions = {},
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
    const operations = new RuntimeOperationState();
    const publisher = new RuntimeSessionEventPublisher(timer);
    const activeSessions = new RuntimeSessions(operations);
    const eventProjection = new RuntimeSessionEventProjection(
        publisher,
        (sessionId, event) => agentRuntime.recordLifecycleEvent(sessionId, event),
        activeSessions.recordSessionEvent,
    );
    const agentRuntime = new AgentRuntimeManager({
        observer: new RuntimeAcpObserver(eventProjection.record, publisher.publishInfo),
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
        new RuntimeDiagnosticLog(stateDirectory),
    );
    const nativeSessions = new NativeSessionService(config, directories, agentRuntime, async (request, options) => {
        return await activeSessions.executionSnapshot(async (command) => {
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
                    sessionTurns: activeSessions,
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
        await activeSessions.close();
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
