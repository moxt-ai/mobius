import {
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRuntimeDiagnosticsResult,
    decodeRuntimePongEvent,
    decodeRuntimeStatusEvent,
    decodeSessionCompletedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionEventEnvelopeV2,
    decodeSessionFailedEvent,
    decodeSessionHistoryPageLoadedV3,
    decodeSessionLiveEventEnvelopeV3,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionResolvedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionPreviewHistoryPageLoadedV3,
    decodeSessionQueuedEvent,
    decodeSessionReadyEvent,
    decodeSessionRestoredEvent,
    decodeSessionSettingsLoadedV3,
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
    type LifecycleMetadataV2,
    type NativeSessionRequest,
    type NativeSessionResult,
    type RuntimeDiagnosticsRequest,
    type RuntimeDiagnosticsResult,
    type RuntimePingCommand,
    type RuntimePongEvent,
    type SessionCancelCommand,
    type SessionCompletedEvent,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionElicitationResolvedEvent,
    type SessionElicitationRespondCommand,
    type SessionHistoryPageLoadedV3,
    type SessionHistoryPageLoadV3,
    type SessionListCommand,
    type SessionLiveEventEnvelopeV3,
    type SessionLiveHistoryV2PageLoad,
    type SessionLiveHistoryV2PageLoaded,
    type SessionPermissionResolvedEvent,
    type SessionPermissionRespondCommand,
    type SessionPermissionResponseV3,
    type SessionPrepareCommand,
    type SessionPreviewHistoryPageLoad,
    type SessionPreviewHistoryPageLoaded,
    type SessionPreviewHistoryPageLoadedV3,
    type SessionPreviewHistoryPageLoadV3,
    type SessionPromptCommand,
    type SessionPromptDispositionCommand,
    type SessionQueryCommand,
    type SessionQueuedEvent,
    type SessionReadyEvent,
    type SessionRestoreCommand,
    type SessionRestoredEvent,
    type SessionSettingChangeV3,
    type SessionSettingsLoadedV3,
    type SessionSettingsReadV3,
    type SessionStartedEvent,
    type SessionsListedEvent,
    type SessionsQueriedEvent,
    type SessionUserInputResponseV3,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";

function commandReply(
    encoded: string,
    prompt = "",
    expectedLifecycleKinds: readonly LifecycleMetadataV2["kind"][] = [],
): string | null {
    if (decodeMessageKind(encoded) !== "session.event.v2") {
        return encoded;
    }
    const lifecycleEvents = decodeSessionEventEnvelopeV2(encoded).events.filter(
        (event) => event.type === "lifecycle-metadata",
    );
    const event =
        lifecycleEvents.find(
            ({ payload }) => payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start",
        ) ?? lifecycleEvents.find(({ payload }) => expectedLifecycleKinds.includes(payload.kind));
    if (event === undefined) {
        return null;
    }
    const payload = event.payload;
    switch (payload.kind) {
        case "prompt.started":
            return JSON.stringify({
                kind: "session.started",
                sessionId: event.sessionId,
                commandId: payload.commandId,
                attemptId: payload.attemptId,
                epoch: payload.epoch,
                sequence: 0,
                prompt,
            });
        case "prompt.completed":
            return JSON.stringify({
                kind: "session.completed",
                sessionId: event.sessionId,
                commandId: payload.commandId,
                stopReason: payload.stopReason,
            });
        case "prompt.failed":
        case "prompt.failed-before-start":
            return JSON.stringify({
                kind: "session.failed",
                sessionId: event.sessionId,
                commandId: payload.commandId,
                code: payload.code,
                message: payload.message,
            });
        case "session.permission.requested":
        case "session.permission.resolved":
        case "session.elicitation.requested":
        case "session.elicitation.resolved":
            return JSON.stringify(payload.event);
        case "prompt.requested":
        case "session.queue.changed":
            return null;
        default: {
            const unsupported: never = payload;
            return unsupported;
        }
    }
}

export type RuntimeControlCommand =
    | RuntimeDiagnosticsRequest
    | RuntimePingCommand
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionConfigureCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionPreviewHistoryPageLoad
    | SessionPreviewHistoryPageLoadV3
    | SessionHistoryPageLoadV3
    | SessionLiveHistoryV2PageLoad
    | SessionElicitationRespondCommand
    | SessionPermissionRespondCommand
    | SessionPermissionResponseV3
    | SessionUserInputResponseV3
    | SessionSettingsReadV3
    | SessionSettingChangeV3
    | SessionListCommand
    | SessionQueryCommand
    | SessionRestoreCommand;
export type RuntimeControlResult =
    | RuntimeDiagnosticsResult
    | RuntimePongEvent
    | NativeSessionResult
    | SessionReadyEvent
    | SessionConfigUpdatedEvent
    | SessionCompletedEvent
    | SessionStartedEvent
    | SessionQueuedEvent
    | SessionPreviewHistoryPageLoaded
    | SessionPreviewHistoryPageLoadedV3
    | SessionHistoryPageLoadedV3
    | SessionLiveHistoryV2PageLoaded
    | SessionElicitationResolvedEvent
    | SessionPermissionResolvedEvent
    | SessionLiveEventEnvelopeV3
    | SessionSettingsLoadedV3
    | SessionsListedEvent
    | SessionsQueriedEvent
    | SessionRestoredEvent;

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
                    const raw = commandReply(event.data);
                    if (raw === null) {
                        return;
                    }
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
                    const expectedLifecycleKinds: readonly LifecycleMetadataV2["kind"][] =
                        command.kind === "session.prompt" || command.kind === "session.prompt.disposition"
                            ? ["prompt.started"]
                            : command.kind === "session.cancel"
                              ? ["prompt.completed"]
                              : command.kind === "session.permission.respond"
                                ? ["session.permission.resolved"]
                                : command.kind === "session.elicitation.respond"
                                  ? ["session.elicitation.resolved"]
                                  : [];
                    const raw = commandReply(
                        event.data,
                        command.kind === "session.prompt" ? command.prompt : "",
                        expectedLifecycleKinds,
                    );
                    if (raw === null) {
                        return;
                    }
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
                    if (
                        kind === "session.live.v3" &&
                        (command.kind === "session.permission.v3.respond" ||
                            command.kind === "session.user-input.v3.respond")
                    ) {
                        const expectedUpdate =
                            command.kind === "session.permission.v3.respond"
                                ? "permission_resolved"
                                : "user_input_resolved";
                        const envelope = decodeSessionLiveEventEnvelopeV3(raw);
                        const resolved = envelope.events.find(
                            (candidate) =>
                                candidate.sessionId === command.sessionId &&
                                candidate.item.sessionUpdate === expectedUpdate &&
                                candidate.item.requestId === command.requestId,
                        );
                        if (resolved !== undefined) {
                            resolve(envelope);
                        }
                        return;
                    }
                    if (kind === "session.live.v3" && command.kind === "session.prompt") {
                        const envelope = decodeSessionLiveEventEnvelopeV3(raw);
                        const lifecycle = envelope.events.find(
                            (candidate) =>
                                candidate.sessionId === command.sessionId &&
                                candidate.item.sessionUpdate === "session_lifecycle_changed",
                        );
                        if (lifecycle?.item.sessionUpdate !== "session_lifecycle_changed") {
                            return;
                        }
                        if (lifecycle.item.state.kind === "failed") {
                            reject(
                                new SessionRuntimeError(
                                    lifecycle.item.state.code,
                                    "The Runtime could not start the Session prompt",
                                ),
                            );
                        } else if (lifecycle.item.state.kind === "running") {
                            resolve(
                                decodeSessionStartedEvent(
                                    JSON.stringify({
                                        attemptId: command.commandId,
                                        commandId: command.commandId,
                                        epoch: command.commandId,
                                        kind: "session.started",
                                        prompt: command.prompt,
                                        sequence: 0,
                                        sessionId: command.sessionId,
                                    }),
                                ),
                            );
                        }
                        return;
                    }
                    if (kind === "session.live.v3" && command.kind === "session.cancel") {
                        const envelope = decodeSessionLiveEventEnvelopeV3(raw);
                        const idle = envelope.events.find(
                            (candidate) =>
                                candidate.sessionId === command.sessionId &&
                                candidate.item.sessionUpdate === "session_lifecycle_changed" &&
                                candidate.item.state.kind === "idle",
                        );
                        if (idle !== undefined) {
                            resolve(
                                decodeSessionCompletedEvent(
                                    JSON.stringify({
                                        commandId: command.commandId,
                                        kind: "session.completed",
                                        sessionId: command.sessionId,
                                        stopReason: "cancelled",
                                    }),
                                ),
                            );
                        }
                        return;
                    }
                    const result =
                        command.kind === "runtime.diagnostics.read" && kind === "runtime.diagnostics.result"
                            ? decodeRuntimeDiagnosticsResult(raw)
                            : command.kind === "runtime.ping" && kind === "runtime.pong"
                              ? decodeRuntimePongEvent(raw)
                              : command.kind === "native.session.request" && kind === "native.session.result"
                                ? decodeNativeSessionResult(raw)
                                : command.kind === "session.list" && kind === "session.listed"
                                  ? decodeSessionsListedEvent(raw)
                                  : command.kind === "session.query" && kind === "session.queried"
                                    ? decodeSessionsQueriedEvent(raw)
                                    : command.kind === "session.restore" && kind === "session.restored"
                                      ? decodeSessionRestoredEvent(raw)
                                      : command.kind === "session.prepare" && kind === "session.ready"
                                        ? decodeSessionReadyEvent(raw)
                                        : command.kind === "session.configure" && kind === "session.config.updated"
                                          ? decodeSessionConfigUpdatedEvent(raw)
                                          : (command.kind === "session.settings.v3.read" ||
                                                  command.kind === "session.setting.v3.change") &&
                                              kind === "session.settings.v3.loaded"
                                            ? decodeSessionSettingsLoadedV3(raw)
                                            : null;
                    const resolved =
                        result ??
                        (command.kind === "session.preview-history.page.load" &&
                        kind === "session.preview-history.page.loaded"
                            ? decodeSessionPreviewHistoryPageLoaded(raw)
                            : command.kind === "session.preview-history.v3.page.load" &&
                                kind === "session.preview-history.v3.page.loaded"
                              ? decodeSessionPreviewHistoryPageLoadedV3(raw)
                              : command.kind === "session.history.v3.page.load" &&
                                  kind === "session.history.v3.page.loaded"
                                ? decodeSessionHistoryPageLoadedV3(raw)
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
                    const raw = commandReply(event.data);
                    if (raw === null) {
                        return;
                    }
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
