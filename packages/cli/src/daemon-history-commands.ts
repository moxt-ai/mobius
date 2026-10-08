import type {
    decodeSessionLiveHistoryLoad,
    decodeSessionLiveHistoryPageLoad,
    decodeSessionLiveHistoryV2PageLoad,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import type { ActiveTurnRecovery } from "./daemon-active-turn.ts";
import { operationErrorCode, operationErrorMessage, reportOperationFailure, send } from "./daemon-command-results.ts";
import { mergeLiveSessionHistory, paginateLiveSessionHistory } from "./native-sessions/live-history-page.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonSessionEventLogV2 } from "./session-event-log-v2.ts";
export async function executeSessionLiveHistoryLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AgentRuntimeManager,
    activeTurn: (sessionId: string) => ActiveTurnRecovery | null,
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const history = await sessions.loadSessionHistory({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        });
        signal.throwIfAborted();
        const mergedHistory = mergeLiveSessionHistory(history, activeTurn(command.sessionId), command.sessionId);
        audit.record({
            commandId: command.requestId,
            event: "session_history_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            history: mergedHistory,
            kind: "session.live-history.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        audit.record({
            commandId: command.requestId,
            details: { code: operationErrorCode(error) },
            event: "session_history_unavailable",
            sessionId: command.sessionId,
        });
        send(socket, {
            history: {
                status: "unavailable",
                cause: { code: operationErrorCode(error), message: operationErrorMessage(error) },
            },
            kind: "session.live-history.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    }
}

export async function executeSessionLiveHistoryPageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryPageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AgentRuntimeManager,
    activeTurn: (sessionId: string) => ActiveTurnRecovery | null,
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const history = await sessions.loadSessionHistory({
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        });
        signal.throwIfAborted();
        const page = paginateLiveSessionHistory(
            history,
            activeTurn(command.sessionId),
            command.sessionId,
            command.cursor,
            command.limit,
        );
        audit.record({
            commandId: command.requestId,
            event: "session_history_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            kind: "session.live-history.page.loaded",
            page,
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        audit.record({
            commandId: command.requestId,
            details: { code: operationErrorCode(error) },
            event: "session_history_unavailable",
            sessionId: command.sessionId,
        });
        send(socket, {
            kind: "session.live-history.page.loaded",
            page: {
                status: "unavailable",
                cause: { code: operationErrorCode(error), message: operationErrorMessage(error) },
                nextCursor: null,
            },
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    }
}

export async function executeSessionLiveHistoryV2PageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryV2PageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    sessions: AgentRuntimeManager,
    eventLogV2: DaemonSessionEventLogV2,
    signal: AbortSignal,
): Promise<void> {
    try {
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            command.directoryId,
            command.additionalDirectoryIds,
            signal,
        );
        const loadOptions = {
            additionalDirectories: resolved.additionalDirectories,
            agent: config.catalog.find(command.agentId),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        };
        const recovery = eventLogV2.promptRequestRecovery(command.sessionId);
        const replay = await sessions.loadSessionEventsV2(loadOptions, command.eventLimit, command.cursor);
        signal.throwIfAborted();
        const events = replay.updates.map((update, index) =>
            eventLogV2.event(command.sessionId, replay.startPosition + index, update, "1970-01-01T00:00:00.000Z"),
        );
        const tailCursor = events.at(-1)?.eventId ?? "";
        audit.record({
            commandId: command.requestId,
            event: "session_event_log_v2_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            events: {
                events: {
                    daemonGenerationId: eventLogV2.daemonGenerationId,
                    events,
                    nextCursor: replay.nextCursor,
                    tailCursor,
                    truncated: replay.truncated,
                    version: 2,
                },
                queuedPromptRequests: recovery.queuedPromptRequests,
            },
            kind: "session.live-history.v2.page.loaded",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    } catch (error) {
        if (!signal.aborted) {
            diagnostics.daemonDiagnostic(
                "session_history_v2_load_failed",
                command.requestId,
                {
                    agentId: command.agentId,
                    code: operationErrorCode(error),
                    sessionId: command.sessionId,
                },
                error,
            );
            audit.record({
                commandId: command.requestId,
                details: {
                    agentId: command.agentId,
                    code: operationErrorCode(error),
                },
                event: "session_history_v2_load_failed",
                sessionId: command.sessionId,
            });
            reportOperationFailure(socket, command.requestId, command.sessionId, error);
        }
    }
}
