import {
    type decodeSessionLiveHistoryV2PageLoad,
    type decodeSessionPreviewHistoryPageLoad,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { operationErrorCode, reportOperationFailure, send } from "./daemon-command-results.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonSessionEventLogV2 } from "./session-event-log-v2.ts";
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
        const events = replay.events.map((event, index) =>
            eventLogV2.event(
                command.sessionId,
                replay.sessionGenerationId,
                replay.startPosition + index,
                event,
                "1970-01-01T00:00:00.000Z",
            ),
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
                    events,
                    nextCursor: replay.nextCursor,
                    sessionGenerationId: replay.sessionGenerationId,
                    tailCursor,
                    truncated: replay.truncated,
                    version: 2,
                },
                queuedPromptRequests: recovery.queuedPromptRequests,
            },
            kind: SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
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

export async function executeSessionPreviewHistoryPageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionPreviewHistoryPageLoad>,
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
        const replay = await sessions.previewNativeSessionEventsV2(
            {
                additionalDirectories: resolved.additionalDirectories,
                agent: config.catalog.find(command.agentId),
                cwd: resolved.cwd,
                sessionId: command.sessionId,
                signal,
            },
            command.sessionId,
            command.eventLimit,
            command.cursor,
        );
        signal.throwIfAborted();
        const events = replay.events.map((event, index) =>
            eventLogV2.event(
                command.sessionId,
                replay.sessionGenerationId,
                replay.startPosition + index,
                event,
                "1970-01-01T00:00:00.000Z",
            ),
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
                    events,
                    nextCursor: replay.nextCursor,
                    sessionGenerationId: replay.sessionGenerationId,
                    tailCursor,
                    truncated: replay.truncated,
                    version: 2,
                },
                queuedPromptRequests: [],
            },
            kind: SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
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
                details: { agentId: command.agentId, code: operationErrorCode(error) },
                event: "session_history_v2_load_failed",
                sessionId: command.sessionId,
            });
            reportOperationFailure(socket, command.requestId, command.sessionId, error);
        }
    }
}
