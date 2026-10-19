import {
    type decodeSessionLiveHistoryPageLoad,
    type decodeSessionPreviewHistoryPageLoad,
    type NativeSessionEvents,
    type QueuedPromptRequestEventLog,
    SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    type SessionEvent,
} from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import { AcpExecutionError, type AgentRuntimeManager } from "../../../acp/agent-runtime-manager.ts";
import type { AcpSessionEventPage } from "../../../acp/session-event-store.ts";
import { resolveSessionDirectories } from "../../../authorization/resolve-session-directories.ts";
import type { WorkspaceDirectoryService } from "../../../authorization/workspace-directory.ts";
import type { NativeSessionService } from "../../../native-sessions/service.ts";
import type { DaemonSessionEventProjection } from "../../../session-event-projection.ts";
import { operationErrorCode, reportOperationFailure, send } from "../../command-dispatcher.ts";
import type { DaemonConfig } from "../../config.ts";
import type { RelayConnectionDiagnostics } from "../../relay/diagnostics.ts";
import type { DaemonCommand } from "../definition.ts";
import { resolveCatalogAgent } from "./session.ts";

function isAgentReasoning(event: SessionEvent | undefined): boolean {
    return event?.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk";
}

interface OrderedHistoryEvent {
    readonly cursor: string | null;
    readonly event: SessionEvent;
}

function omitAgentReasoning(events: readonly OrderedHistoryEvent[]): readonly OrderedHistoryEvent[] {
    const retained: OrderedHistoryEvent[] = [];
    let previousReasoningMessageId: string | null | undefined;
    for (const positioned of events) {
        const { event } = positioned;
        if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
            previousReasoningMessageId = undefined;
            retained.push(positioned);
            continue;
        }
        const messageId = event.payload.messageId ?? null;
        if (previousReasoningMessageId === undefined || previousReasoningMessageId !== messageId) {
            retained.push({
                ...positioned,
                event: {
                    ...event,
                    mobiusMetadata: { omitted: true },
                    payload: { ...event.payload, content: { text: "", type: "text" } },
                },
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
    queuedPromptRequests: readonly QueuedPromptRequestEventLog[],
    load: (eventLimit: number, cursor: string | null) => Promise<AcpSessionEventPage>,
): Promise<NativeSessionEvents> {
    let cursor = initialCursor;
    let loaded: readonly OrderedHistoryEvent[] = [];
    let sessionGenerationId: string | null = null;
    let sourceNextCursor: string | null = null;
    do {
        const replay = await load(eventLimit, cursor);
        if (sessionGenerationId !== null && replay.sessionGenerationId !== sessionGenerationId) {
            throw new AcpExecutionError("The Session reloaded while history was loading", {}, "session_reloaded");
        }
        if (
            replay.events.some(
                (event) => event.sessionId !== sessionId || event.sessionGenerationId !== replay.sessionGenerationId,
            )
        ) {
            throw new AcpExecutionError(
                "The Session history contains events from another Session",
                {},
                "session_history_unavailable",
            );
        }
        sessionGenerationId = replay.sessionGenerationId;
        const events = replay.events.map((event, index) => {
            const eventCursor = replay.nextCursor === null && index === 0 ? null : event.eventId;
            return { cursor: eventCursor, event };
        });
        loaded = [...events, ...loaded];
        sourceNextCursor = replay.nextCursor;
        const visible = omitReasoning ? omitAgentReasoning(loaded) : loaded;
        const reasoningContinuesBeforePage = sourceNextCursor !== null && isAgentReasoning(loaded[0]?.event);
        if (visible.length >= eventLimit && !reasoningContinuesBeforePage) {
            break;
        }
        cursor = sourceNextCursor;
    } while (cursor !== null);

    if (sessionGenerationId === null) {
        throw new AcpExecutionError("The Session history is unavailable", {}, "session_history_unavailable");
    }
    const visible = omitReasoning ? omitAgentReasoning(loaded) : loaded;
    const orderedEvents = visible.slice(-eventLimit);
    const nextCursor = orderedEvents[0]?.cursor ?? null;
    return {
        events: {
            events: orderedEvents.map(({ event }) => event),
            nextCursor,
            sessionGenerationId,
            tailCursor: orderedEvents.at(-1)?.event.eventId ?? "",
            truncated: nextCursor !== null,
            version: 2,
        },
        queuedPromptRequests,
    };
}

export async function executeSessionLiveHistoryPageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionLiveHistoryPageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    diagnostics: RelayConnectionDiagnostics,
    sessions: AgentRuntimeManager,
    nativeSessions: NativeSessionService,
    eventProjection: DaemonSessionEventProjection,
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
        const recovery = eventProjection.promptRequestRecovery(command.sessionId);
        const events = await loadHistoryPage(
            command.sessionId,
            command.eventLimit,
            command.cursor,
            command.omit?.includes("agent-reasoning") === true,
            recovery.queuedPromptRequests,
            async (eventLimit, cursor) => await sessions.loadSessionEvents(loadOptions, eventLimit, cursor),
        );
        signal.throwIfAborted();
        send(socket, {
            events,
            kind: SESSION_LIVE_HISTORY_PAGE_LOADED_KIND,
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
            reportOperationFailure(socket, command.requestId, command.sessionId, error);
        }
    }
}

export async function executeSessionPreviewHistoryPageLoad(
    socket: WebSocket,
    command: ReturnType<typeof decodeSessionPreviewHistoryPageLoad>,
    config: DaemonConfig,
    directories: WorkspaceDirectoryService,
    diagnostics: RelayConnectionDiagnostics,
    sessions: AgentRuntimeManager,
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
                await sessions.previewNativeSessionEvents(loadOptions, command.sessionId, eventLimit, cursor),
        );
        signal.throwIfAborted();
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
            reportOperationFailure(socket, command.requestId, command.sessionId, error);
        }
    }
}

export const liveHistoryPageLoadCommand: DaemonCommand = {
    kind: SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_LIVE_HISTORY_PAGE_LOAD_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionLiveHistoryPageLoad(
            context.socket,
            message,
            context.config,
            context.directories,
            context.diagnostics,
            context.sessions,
            context.nativeSessions,
            context.eventProjection,
            context.signal,
        );
    },
};

export const previewHistoryPageLoadCommand: DaemonCommand = {
    kind: SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND) {
            throw new Error("Command kind mismatch");
        }
        void executeSessionPreviewHistoryPageLoad(
            context.socket,
            message,
            context.config,
            context.directories,
            context.diagnostics,
            context.sessions,
            context.signal,
        );
    },
};
