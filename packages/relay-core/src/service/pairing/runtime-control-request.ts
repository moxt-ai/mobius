import {
    type AgentCatalogRefreshCommand,
    type AgentCatalogRefreshedEvent,
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    decodeAgentCatalogRefreshedEvent,
    decodeAgentCatalogRefreshFailedEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRuntimeStatusEvent,
    decodeSessionCompletedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionEventEnvelope,
    decodeSessionFailedEvent,
    decodeSessionLiveHistoryPageLoaded,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionResolvedEvent,
    decodeSessionQueuedEvent,
    decodeSessionReadyEvent,
    decodeSessionStartedEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceEntriesEvent,
    encodeNativeSessionRequest,
    encodeServiceToDaemonMessage,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    type FileReadCommand,
    type NativeSessionRequest,
    type NativeSessionResult,
    type SessionCancelCommand,
    type SessionCompletedEvent,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionElicitationResolvedEvent,
    type SessionElicitationRespondCommand,
    type SessionListCommand,
    type SessionLiveHistoryPageLoad,
    type SessionLiveHistoryPageLoaded,
    type SessionLiveHistoryV2PageLoad,
    type SessionLiveHistoryV2PageLoaded,
    type SessionPermissionResolvedEvent,
    type SessionPermissionRespondCommand,
    type SessionPrepareCommand,
    type SessionPromptCommand,
    type SessionPromptDispositionCommand,
    type SessionQueryCommand,
    type SessionQueuedEvent,
    type SessionReadyEvent,
    type SessionStartedEvent,
    type SessionsListedEvent,
    type SessionsQueriedEvent,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";

export type RuntimeControlCommand =
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionConfigureCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionLiveHistoryPageLoad
    | SessionLiveHistoryV2PageLoad
    | SessionElicitationRespondCommand
    | SessionPermissionRespondCommand
    | SessionListCommand
    | SessionQueryCommand;
export type RuntimeControlResult =
    | NativeSessionResult
    | SessionReadyEvent
    | SessionConfigUpdatedEvent
    | SessionCompletedEvent
    | SessionStartedEvent
    | SessionQueuedEvent
    | SessionLiveHistoryPageLoaded
    | SessionLiveHistoryV2PageLoaded
    | SessionElicitationResolvedEvent
    | SessionPermissionResolvedEvent
    | SessionsListedEvent
    | SessionsQueriedEvent;

export interface RuntimeFileStream {
    readonly finished: Promise<void>;
    readonly response: Response;
}

export async function requestRuntimeFile(
    socket: WebSocket,
    command: FileReadCommand,
    signal: AbortSignal,
): Promise<RuntimeFileStream> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let settleFinished = () => {};
    const finished = new Promise<void>((resolve) => {
        settleFinished = resolve;
    });
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let responseSettled = false;
    let transferFinished = false;
    let expectedBytes = 0;
    let receivedBytes = 0;
    let nextSequence = 0;
    let cleanup = () => {};
    const response = await new Promise<Response>((resolve, reject) => {
        const finish = (): void => {
            if (transferFinished) {
                return;
            }
            transferFinished = true;
            cleanup();
            socket.close(1000, "Operation finished");
            settleFinished();
        };
        const fail = (cause: unknown): void => {
            if (transferFinished) {
                return;
            }
            if (responseSettled) {
                stream?.error(cause);
            } else {
                reject(cause);
            }
            finish();
        };
        const onClose = (): void => fail(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
        const onAbort = (): void => fail(deadline.reason);
        const onMessage = (event: MessageEvent): void => {
            try {
                if (typeof event.data !== "string") {
                    return;
                }
                const kind = decodeMessageKind(event.data);
                if (kind === "runtime.status") {
                    if (!decodeRuntimeStatusEvent(event.data).online) {
                        onClose();
                    }
                    return;
                }
                if (kind === FILE_FAILED_KIND) {
                    const failure = decodeFileFailedEvent(event.data);
                    if (failure.requestId === command.requestId) {
                        fail(new SessionRuntimeError(failure.code, failure.message));
                    }
                    return;
                }
                if (kind === FILE_BEGIN_KIND) {
                    const begin = decodeFileBeginEvent(event.data);
                    if (begin.requestId !== command.requestId) {
                        return;
                    }
                    if (responseSettled || begin.byteLength > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime returned invalid file metadata");
                    }
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                        cancel() {
                            finish();
                        },
                    });
                    responseSettled = true;
                    expectedBytes = begin.byteLength;
                    resolve(
                        new Response(body, {
                            headers: {
                                "cache-control": "no-store",
                                "content-length": begin.byteLength.toString(),
                                "content-type": begin.mediaType,
                                "last-modified": new Date(begin.modifiedAt).toUTCString(),
                                "x-mobius-byte-length": begin.byteLength.toString(),
                                "x-mobius-file-name": encodeURIComponent(begin.name),
                            },
                        }),
                    );
                    return;
                }
                if (kind === FILE_CHUNK_KIND) {
                    const chunk = decodeFileChunkEvent(event.data);
                    if (chunk.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || chunk.sequence !== nextSequence) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime returned invalid file chunks");
                    }
                    const binary = atob(chunk.data);
                    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
                    receivedBytes += bytes.byteLength;
                    if (receivedBytes > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime exceeded the file size limit");
                    }
                    nextSequence += 1;
                    stream?.enqueue(bytes);
                    return;
                }
                if (kind === FILE_END_KIND) {
                    const end = decodeFileEndEvent(event.data);
                    if (end.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || receivedBytes !== expectedBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime ended an unknown file stream");
                    }
                    stream?.close();
                    finish();
                }
            } catch (cause) {
                fail(
                    cause instanceof SessionRuntimeError
                        ? cause
                        : new SessionRuntimeError("invalid_request", "The Runtime returned an invalid file", {
                              cause,
                          }),
                );
            }
        };
        cleanup = () => {
            deadline.removeEventListener("abort", onAbort);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onClose);
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onClose);
        deadline.addEventListener("abort", onAbort, { once: true });
        try {
            deadline.throwIfAborted();
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        } catch (cause) {
            fail(cause);
        }
    });
    return { finished, response };
}

export async function requestRuntimeAgentSettings(
    socket: WebSocket,
    command: AgentSettingsDiscoverCommand,
    signal: AbortSignal,
): Promise<AgentSettingsDiscoveredEvent> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<AgentSettingsDiscoveredEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: MessageEvent) => {
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const raw =
                        decodeMessageKind(event.data) === "session.event"
                            ? decodeSessionEventEnvelope(event.data).payload
                            : event.data;
                    const kind = decodeMessageKind(raw);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(raw).online) {
                            reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
                        }
                        return;
                    }
                    if (kind === "agent.settings.discovery.failed") {
                        const failed = decodeAgentSettingsDiscoveryFailedEvent(raw);
                        if (failed.requestId === command.requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind !== "agent.settings.discovered") {
                        return;
                    }
                    const result = decodeAgentSettingsDiscoveredEvent(raw);
                    if (result.requestId === command.requestId) {
                        resolve(result);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Runtime returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        });
    } finally {
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeAgentCatalogRefresh(
    socket: WebSocket,
    command: AgentCatalogRefreshCommand,
    signal: AbortSignal,
): Promise<AgentCatalogRefreshedEvent> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<AgentCatalogRefreshedEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: MessageEvent) => {
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const raw =
                        decodeMessageKind(event.data) === "session.event"
                            ? decodeSessionEventEnvelope(event.data).payload
                            : event.data;
                    const kind = decodeMessageKind(raw);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(raw).online) {
                            reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
                        }
                        return;
                    }
                    if (kind === "agent.catalog.refresh.failed") {
                        const failed = decodeAgentCatalogRefreshFailedEvent(raw);
                        if (failed.requestId === command.requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind !== "agent.catalog.refreshed") {
                        return;
                    }
                    const refreshed = decodeAgentCatalogRefreshedEvent(raw);
                    if (refreshed.requestId === command.requestId) {
                        resolve(refreshed);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Runtime returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        });
    } finally {
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeControl(
    socket: WebSocket,
    command: RuntimeControlCommand,
    signal: AbortSignal,
): Promise<RuntimeControlResult> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const requestId =
        command.kind === "session.prompt" ||
        command.kind === "session.prompt.disposition" ||
        command.kind === "session.cancel"
            ? command.commandId
            : command.kind === "session.permission.respond" || command.kind === "session.elicitation.respond"
              ? command.interactionId
              : command.requestId;
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<RuntimeControlResult>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => {
                if (command.kind === "native.session.request" && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        encodeServiceToDaemonMessage({
                            kind: "native.session.cancel",
                            requestId: command.requestId,
                            sessionId: command.sessionId,
                        }),
                    );
                }
                reject(deadline.reason);
            };
            const onMessage = (event: MessageEvent) => {
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const raw =
                        decodeMessageKind(event.data) === "session.event"
                            ? decodeSessionEventEnvelope(event.data).payload
                            : event.data;
                    const kind = decodeMessageKind(raw);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(raw).online) {
                            reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
                        }
                        return;
                    }
                    if (kind === "session.failed") {
                        const failed = decodeSessionFailedEvent(raw);
                        if (failed.commandId === requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(raw);
                        if (failed.requestId === requestId) {
                            reject(
                                new SessionRuntimeError(failed.code, failed.message, {
                                    runtimeTimings: failed.runtimeTimings,
                                }),
                            );
                        }
                        return;
                    }
                    const result =
                        command.kind === "native.session.request" && kind === "native.session.result"
                            ? decodeNativeSessionResult(raw)
                            : command.kind === "session.list" && kind === "session.listed"
                              ? decodeSessionsListedEvent(raw)
                              : command.kind === "session.query" && kind === "session.queried"
                                ? decodeSessionsQueriedEvent(raw)
                                : command.kind === "session.prepare" && kind === "session.ready"
                                  ? decodeSessionReadyEvent(raw)
                                  : command.kind === "session.configure" && kind === "session.config.updated"
                                    ? decodeSessionConfigUpdatedEvent(raw)
                                    : null;
                    const resolved =
                        result ??
                        (command.kind === "session.live-history.page.load" &&
                        kind === "session.live-history.page.loaded"
                            ? decodeSessionLiveHistoryPageLoaded(raw)
                            : command.kind === "session.live-history.v2.page.load" &&
                                kind === "session.live-history.v2.page.loaded"
                              ? decodeSessionLiveHistoryV2PageLoaded(raw)
                              : command.kind === "session.prompt" && kind === "session.queued"
                                ? decodeSessionQueuedEvent(raw)
                                : (command.kind === "session.prompt" ||
                                        command.kind === "session.prompt.disposition") &&
                                    kind === "session.started"
                                  ? decodeSessionStartedEvent(raw)
                                  : command.kind === "session.cancel" && kind === "session.completed"
                                    ? decodeSessionCompletedEvent(raw)
                                    : command.kind === "session.permission.respond" &&
                                        kind === "session.permission.resolved"
                                      ? decodeSessionPermissionResolvedEvent(raw)
                                      : command.kind === "session.elicitation.respond" &&
                                          kind === "session.elicitation.resolved"
                                        ? decodeSessionElicitationResolvedEvent(raw)
                                        : null);
                    const resolvedRequestId =
                        resolved !== null && "requestId" in resolved
                            ? resolved.requestId
                            : resolved !== null && "interactionId" in resolved
                              ? resolved.interactionId
                              : resolved?.commandId;
                    if (resolved !== null && resolvedRequestId === requestId) {
                        resolve(resolved);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Runtime returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(
                command.kind === "native.session.request"
                    ? encodeNativeSessionRequest(command)
                    : encodeServiceToDaemonMessage(command),
            );
        });
    } finally {
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeWorkspace(
    socket: WebSocket,
    command: WorkspaceListCommand,
    signal: AbortSignal,
): Promise<WorkspaceEntriesEvent> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<WorkspaceEntriesEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: MessageEvent) => {
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const raw =
                        decodeMessageKind(event.data) === "session.event"
                            ? decodeSessionEventEnvelope(event.data).payload
                            : event.data;
                    const kind = decodeMessageKind(raw);
                    if (kind === "session.failed") {
                        const failed = decodeSessionFailedEvent(raw);
                        if (failed.commandId === command.requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(raw);
                        if (failed.requestId === command.requestId) {
                            reject(
                                new SessionRuntimeError(failed.code, failed.message, {
                                    runtimeTimings: failed.runtimeTimings,
                                }),
                            );
                        }
                        return;
                    }
                    if (kind !== "workspace.entries") {
                        return;
                    }
                    const result = decodeWorkspaceEntriesEvent(raw);
                    if (result.requestId === command.requestId) {
                        resolve(result);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Runtime returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        });
    } finally {
        cleanup();
        socket.close(1000, "Operation finished");
    }
}
