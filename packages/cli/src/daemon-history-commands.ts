import type {
    decodeSessionLiveHistoryLoad,
    decodeSessionLiveHistoryPageLoad,
    NativeSessionResult,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { operationErrorCode, operationErrorMessage, send } from "./daemon-command-results.ts";
import { mergeLiveSessionHistory, paginateLiveSessionHistory } from "./native-sessions/live-history-page.ts";
export async function executeSessionLiveHistoryLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    sessions: AgentRuntimeManager,
    activeTurn: (sessionId: string) => Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"],
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
    activeTurn: (sessionId: string) => Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"],
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
