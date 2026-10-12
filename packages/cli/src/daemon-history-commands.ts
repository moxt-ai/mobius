import {
    type decodeSessionLiveHistoryV2PageLoad,
    type decodeSessionPreviewHistoryPageLoad,
    type NativeSessionEventsV2,
    type QueuedPromptRequestEventLogV2,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    type SessionEventV2,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import { AcpExecutionError, type AgentRuntimeManager } from "./acp/agent-runtime-manager.ts";
import type { AcpSessionEventPageV2 } from "./acp/session-event-store-v2.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { resolveSessionDirectories } from "./authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { operationErrorCode, reportOperationFailure, send } from "./daemon-command-results.ts";
import { resolveCatalogAgent } from "./daemon-session-commands.ts";
import type { NativeSessionService } from "./native-sessions/service.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";
import type { DaemonSessionEventLogV2 } from "./session-event-log-v2.ts";

function isAgentReasoning(event: SessionEventV2 | undefined): boolean {
    return event?.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk";
}

function omitAgentReasoning(events: readonly SessionEventV2[]): readonly SessionEventV2[] {
    const retained: SessionEventV2[] = [];
    let previousReasoningMessageId: string | null | undefined;
    for (const event of events) {
        if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
            previousReasoningMessageId = undefined;
            retained.push(event);
            continue;
        }
        const messageId = event.payload.messageId ?? null;
        if (previousReasoningMessageId === undefined || previousReasoningMessageId !== messageId) {
            retained.push({
                ...event,
                mobiusMetadata: { omitted: true },
                payload: { ...event.payload, content: { text: "", type: "text" } },
            });
        }
        previousReasoningMessageId = messageId;
    }
    return retained;
}

async function loadHistoryPage(
    sessionId: string,
    eventLimit: number,
    initialCursor: string | null,
    omitReasoning: boolean,
    queuedPromptRequests: readonly QueuedPromptRequestEventLogV2[],
    load: (eventLimit: number, cursor: string | null) => Promise<AcpSessionEventPageV2>,
    eventLogV2: DaemonSessionEventLogV2,
): Promise<NativeSessionEventsV2> {
    let cursor = initialCursor;
    let loaded: readonly SessionEventV2[] = [];
    let sessionGenerationId: string | null = null;
    let sourceNextCursor: string | null = null;
    do {
        const replay = await load(eventLimit, cursor);
        if (sessionGenerationId !== null && replay.sessionGenerationId !== sessionGenerationId) {
            throw new AcpExecutionError("The Session reloaded while history was loading", {}, "session_reloaded");
        }
        sessionGenerationId = replay.sessionGenerationId;
        const events = replay.events.map((event, index) =>
            eventLogV2.event(
                sessionId,
                replay.sessionGenerationId,
                replay.startPosition + index,
                event,
                "1970-01-01T00:00:00.000Z",
            ),
        );
        loaded = [...events, ...loaded];
        sourceNextCursor = replay.nextCursor;
        const visible = omitReasoning ? omitAgentReasoning(loaded) : loaded;
        const reasoningContinuesBeforePage = sourceNextCursor !== null && isAgentReasoning(loaded[0]);
        if (visible.length >= eventLimit && !reasoningContinuesBeforePage) {
            break;
        }
        cursor = sourceNextCursor;
    } while (cursor !== null);

    if (sessionGenerationId === null) {
        throw new AcpExecutionError("The Session history is unavailable", {}, "session_history_unavailable");
    }
    const visible = omitReasoning ? omitAgentReasoning(loaded) : loaded;
    const events = visible.slice(-eventLimit);
    const firstPosition = events[0] === undefined ? 0 : Number(events[0].position);
    const nextCursor = firstPosition <= 1 ? null : (firstPosition - 1).toString();
    return {
        events: {
            events,
            nextCursor,
            sessionGenerationId,
            tailCursor: events.at(-1)?.eventId ?? "",
            truncated: nextCursor !== null,
            version: 2,
        },
        queuedPromptRequests,
    };
}

export async function executeSessionLiveHistoryV2PageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryV2PageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    sessions: AgentRuntimeManager,
    nativeSessions: NativeSessionService,
    eventLogV2: DaemonSessionEventLogV2,
    signal: AbortSignal,
): Promise<void> {
    let agentId: string | undefined;
    try {
        const [entry] = await nativeSessions.querySessions([command.sessionId], signal);
        if (entry === undefined) {
            throw new AcpExecutionError("The Session was not found", {}, "session_not_found");
        }
        agentId = entry.agentId;
        const resolved = await resolveSessionDirectories(
            directories,
            config.bindingId,
            entry.directoryId,
            entry.additionalDirectories.map((directory) => directory.directoryId),
            signal,
        );
        const loadOptions = {
            additionalDirectories: resolved.additionalDirectories,
            agent: await resolveCatalogAgent(config, entry.agentId, signal),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        };
        const recovery = eventLogV2.promptRequestRecovery(command.sessionId);
        const events = await loadHistoryPage(
            command.sessionId,
            command.eventLimit,
            command.cursor,
            command.omit?.includes("agent-reasoning") === true,
            recovery.queuedPromptRequests,
            async (eventLimit, cursor) => await sessions.loadSessionEventsV2(loadOptions, eventLimit, cursor),
            eventLogV2,
        );
        signal.throwIfAborted();
        audit.record({
            commandId: command.requestId,
            event: "session_event_log_v2_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            events,
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
                    ...(agentId === undefined ? {} : { agentId }),
                    code: operationErrorCode(error),
                    sessionId: command.sessionId,
                },
                error,
            );
            audit.record({
                commandId: command.requestId,
                details: {
                    ...(agentId === undefined ? {} : { agentId }),
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
        const loadOptions = {
            additionalDirectories: resolved.additionalDirectories,
            agent: await resolveCatalogAgent(config, command.agentId, signal),
            cwd: resolved.cwd,
            sessionId: command.sessionId,
            signal,
        };
        const events = await loadHistoryPage(
            command.sessionId,
            command.eventLimit,
            command.cursor,
            command.omit?.includes("agent-reasoning") === true,
            [],
            async (eventLimit, cursor) =>
                await sessions.previewNativeSessionEventsV2(loadOptions, command.sessionId, eventLimit, cursor),
            eventLogV2,
        );
        signal.throwIfAborted();
        audit.record({
            commandId: command.requestId,
            event: "session_event_log_v2_loaded",
            sessionId: command.sessionId,
        });
        send(socket, {
            events,
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
