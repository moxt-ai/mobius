import { styleText } from "node:util";
import { harnessAdapters } from "../acp/adapter/registry.ts";
import { AcpContentExternalizer } from "../acp/content/content-externalizer.ts";
import { LocalExternalContentStore } from "../session/content/external-content-store.ts";
import { SqliteSessionLiveEventPosition } from "../session/history/live-event-positions.ts";
import { CachedSessionEventStore } from "../session/history/session-event-store.ts";
import { SessionManager } from "../session/manager/session-manager.ts";
import { NativeSessionService } from "../session/native/native-session-browser.ts";
import { resolveMaxAcpProcesses } from "../session/process/agent-process-pool.ts";
import { PromptLifecycle } from "../session/prompt/prompt-lifecycle.ts";
import { SqliteSessionStore } from "../session/record/session-store.ts";
import { ExecutionReceipts } from "../session/turn/execution-receipts.ts";
import { SessionTurns } from "../session/turn/session-turns.ts";
import { WorkspaceDirectoryService } from "../session/workspace/workspace-directory.ts";
import { AcpSessionTable } from "../storage/session/acp-session-table.ts";
import { LiveEventPositionTable } from "../storage/session/live-event-position-table.ts";
import { SessionEventCacheTable } from "../storage/session/session-event-cache-table.ts";
import {
    channelSessionDatabasePaths,
    openAcpSessionDatabase,
    openSessionEventCacheDatabase,
} from "../storage/sqlite/local-databases.ts";
import { systemTimer, type Timer } from "../util/timer.ts";
import { RuntimeAcpObserver } from "./acp-observer.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import type { RuntimeConfig } from "./config.ts";
import { RuntimeDiagnosticLog } from "./observability/diagnostic-log.ts";
import { RelayConnectionDiagnostics } from "./relay/diagnostics.ts";
import { runRelayConnection } from "./relay/run-relay-connection.ts";
import { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
import { RuntimeSessionEventPublisher } from "./relay/session-event-publisher.ts";

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
    const shutdown = new AbortController();
    const signal = AbortSignal.any([parentSignal, shutdown.signal]);
    const stateDirectory = config.localContext.stateDirectory;
    const databases = channelSessionDatabasePaths(stateDirectory, config.channelId);
    const sessionDatabase = openAcpSessionDatabase(databases.sessions);
    let events: CachedSessionEventStore;
    try {
        events = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databases.events)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
    } catch (error) {
        sessionDatabase.close();
        throw error;
    }
    const sessionStore = new SqliteSessionStore(new AcpSessionTable(sessionDatabase), events);
    await using externalContent = new LocalExternalContentStore(stateDirectory);
    const operations = new ExecutionReceipts();
    const publisher = new RuntimeSessionEventPublisher(timer);
    const activeSessions = new SessionTurns(operations);
    const eventProjection = new PromptLifecycle(
        publisher,
        (sessionId, event) => agentRuntime.recordLifecycleEvent(sessionId, event),
        activeSessions.recordSessionEvent,
    );
    const agentRuntime = new SessionManager({
        observer: new RuntimeAcpObserver(eventProjection.record, publisher.publishInfo),
        store: sessionStore,
        adapters: harnessAdapters,
        sessionIdentity: "native",
        onSessionStatusChanged: publisher.publishStatus,
        onSessionClosed: publisher.publishClosed,
        contentExternalizer: new AcpContentExternalizer(externalContent),
        timer,
        maxProcesses: resolveMaxAcpProcesses(config.localContext.environment),
    });
    const directories = new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace);
    const diagnostics = new RelayConnectionDiagnostics(
        config.channelId,
        config.relayUrl,
        new RuntimeDiagnosticLog(stateDirectory, {
            ...(options.processLogsDirectory === undefined
                ? {}
                : { processLogsDirectory: options.processLogsDirectory }),
        }),
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
