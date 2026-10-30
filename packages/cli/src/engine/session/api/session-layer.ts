import type { SessionInfoUpdatedEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import { AcpSessionTable } from "../../storage/session/acp-session-table.ts";
import { ExecutionReceiptTable } from "../../storage/session/execution-receipt-table.ts";
import { LiveEventPositionTable } from "../../storage/session/live-event-position-table.ts";
import { SessionEventCacheTable } from "../../storage/session/session-event-cache-table.ts";
import {
    channelSessionDatabasePaths,
    openAcpSessionDatabase,
    openSessionEventCacheDatabase,
} from "../../storage/sqlite/local-databases.ts";
import type { Timer } from "../../util/timer.ts";
import { SqliteSessionLiveEventPosition } from "../history/live-event-positions.ts";
import { CachedSessionEventStore } from "../history/session-event-store.ts";
import { SessionManager } from "../manager/session-manager.ts";
import { NativeSessionService } from "../native/native-session-browser.ts";
import type { AgentProcessPool } from "../process/agent-process-pool.ts";
import { PromptLifecycle } from "../prompt/prompt-lifecycle.ts";
import { SqliteSessionStore } from "../record/session-store.ts";
import { ExecutionReceipts } from "../turn/execution-receipts.ts";
import type { RuntimeTurnActivity } from "../turn/runtime-turn-activity.ts";
import { SessionTurns } from "../turn/session-turns.ts";
import { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import type { ResolveAgent, SessionEventSink } from "./session-api.ts";
import { NullSessionObserver } from "./session-api.ts";

/** Records live session events through the projection and publishes info updates through the sink. */
export class SessionLayerObserver extends NullSessionObserver {
    readonly #backgroundActivity: (source: object, activity: BackgroundActivity) => void;
    readonly #publishInfo: (event: SessionInfoUpdatedEvent) => void;
    readonly #record: (event: SessionLiveEvent) => void;

    constructor(
        record: (event: SessionLiveEvent) => void,
        publishInfo: (event: SessionInfoUpdatedEvent) => void,
        backgroundActivity: (source: object, activity: BackgroundActivity) => void = () => {},
    ) {
        super();
        this.#backgroundActivity = backgroundActivity;
        this.#publishInfo = publishInfo;
        this.#record = record;
    }

    override readonly onBackgroundActivity = (source: object, activity: BackgroundActivity): void => {
        this.#backgroundActivity(source, activity);
    };

    override readonly onSessionEvent = (event: SessionLiveEvent): Promise<void> => {
        this.#record(event);
        return Promise.resolve();
    };

    override readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#publishInfo(event);
        return Promise.resolve();
    };
}

/** What the session layer needs to wire itself: the runtime's identity, its agent source, and its sink. */
export interface SessionLayerOptions {
    readonly processes: AgentProcessPool;
    readonly turnActivity?: RuntimeTurnActivity;
    readonly onExecutionCountChange?: (count: number) => void;
    readonly bindingId: string;
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly resolveAgent: ResolveAgent;
    readonly sink: SessionEventSink;
    readonly stateDirectory: string;
    readonly timer: Timer;
}

/** Wires the session layer for one runtime: its stores, manager, turns, and native session browsing. */
export function buildSessionLayer(options: SessionLayerOptions) {
    const { bindingId, channelId, defaultWorkspace, resolveAgent, sink, stateDirectory, timer } = options;
    const databases = channelSessionDatabasePaths(stateDirectory, channelId);
    const sessionDatabase = openAcpSessionDatabase(databases.sessions);
    let events: CachedSessionEventStore;
    let operations: ExecutionReceipts;
    try {
        operations = new ExecutionReceipts(new ExecutionReceiptTable(sessionDatabase), options.onExecutionCountChange);
        events = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databases.events)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
    } catch (error) {
        sessionDatabase.close();
        throw error;
    }
    const sessionStore = new SqliteSessionStore(new AcpSessionTable(sessionDatabase), events);
    const activeSessions = new SessionTurns(operations, options.turnActivity);
    const directories = new WorkspaceDirectoryService(bindingId, defaultWorkspace);
    const manager = new SessionManager({
        observer: new SessionLayerObserver(
            (event) => {
                operations.recordOutcome(event);
                eventProjection.record(event);
            },
            sink.publishInfo,
            (source, activity) => {
                options.turnActivity?.setBackgroundActivity(source, activity);
                options.processes.notifyChanged();
            },
        ),
        store: sessionStore,
        processes: options.processes,
        sessionIdentity: "native",
        onSessionStatusChanged: sink.publishStatus,
        onSessionClosed: sink.publishClosed,
        timer,
    });
    const eventProjection = new PromptLifecycle(
        sink,
        async (sessionId, event) => {
            if (await manager.recordLifecycleEvent(sessionId, event)) {
                return true;
            }
            const recorded = events.append(sessionId, event);
            operations.recordOutcome(recorded);
            eventProjection.record(recorded);
            return true;
        },
        activeSessions.recordSessionEvent,
        operations.hasStarted,
    );
    const nativeSessions = new NativeSessionService(
        bindingId,
        resolveAgent,
        directories,
        manager,
        async (request, requestOptions) => {
            const snapshot = await activeSessions.executionSnapshot(async (command) => {
                if (command.sessionId !== request.targetSessionId || command.agentId !== request.agentId) {
                    return false;
                }
                const cwd = await directories.resolve(command.bindingId, command.directoryId, requestOptions.signal);
                const additionalDirectories = await directories.resolveMany(
                    command.bindingId,
                    command.additionalDirectoryIds,
                    requestOptions.signal,
                );
                return (
                    cwd === requestOptions.cwd &&
                    additionalDirectories.length === requestOptions.additionalDirectories.length &&
                    additionalDirectories.every(
                        (directory, index) => directory === requestOptions.additionalDirectories[index],
                    )
                );
            });
            // Read after the snapshot, so neither is older than the execution beside it.
            const lastTurn = snapshot.turn === null ? operations.lastTurn(request.targetSessionId) : undefined;
            const interactionState = manager.interactionSnapshot({
                ...requestOptions,
                sessionId: request.targetSessionId,
            });
            return {
                ...snapshot,
                ...(interactionState === undefined ? {} : { interactionState }),
                ...(request.deliveryCommandId === undefined
                    ? {}
                    : { command: operations.delivery(request.deliveryCommandId, request.targetSessionId) }),
                ...(lastTurn === undefined ? {} : { lastTurn }),
            };
        },
    );
    const recoveredEvents = operations
        .recover()
        .map(({ sessionId, event, recordedAt }) => events.append(sessionId, event, recordedAt));
    return {
        publishRecoveredOutcomes: () => {
            for (const event of recoveredEvents) {
                sink.publish(event);
            }
        },
        activeSessions,
        directories,
        eventProjection,
        manager,
        nativeSessions,
        operations,
        sessionStore,
    };
}
