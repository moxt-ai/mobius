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
    decodeSessionClosedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionResolvedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionRestoredEvent,
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
    SESSION_EVENT_V2_KIND,
    type SessionCancelCommand,
    type SessionCloseCommand,
    type SessionClosedEvent,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionElicitationResolvedEvent,
    type SessionElicitationRespondCommand,
    type SessionListCommand,
    type SessionLiveHistoryV2PageLoad,
    type SessionLiveHistoryV2PageLoaded,
    type SessionPermissionResolvedEvent,
    type SessionPermissionRespondCommand,
    type SessionPrepareCommand,
    type SessionPreviewHistoryPageLoad,
    type SessionPreviewHistoryPageLoaded,
    type SessionPromptCommand,
    type SessionPromptDispositionCommand,
    type SessionQueryCommand,
    type SessionReadyEvent,
    type SessionRenameCommand,
    type SessionRenamedEvent,
    type SessionRestoreCommand,
    type SessionRestoredEvent,
    type SessionsListedEvent,
    type SessionsQueriedEvent,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";

export type RuntimeControlCommand =
    | RuntimeDiagnosticsRequest
    | RuntimePingCommand
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionConfigureCommand
    | SessionRenameCommand
    | SessionCloseCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionPreviewHistoryPageLoad
    | SessionLiveHistoryV2PageLoad
    | SessionElicitationRespondCommand
    | SessionPermissionRespondCommand
    | SessionListCommand
    | SessionQueryCommand
    | SessionRestoreCommand;

/** A Turn attempt started executing on the Runtime. */
export interface TurnStarted {
    readonly attemptId: string;
    readonly commandId: string;
    readonly epoch: string;
    readonly kind: "turn.started";
    readonly sessionId: string;
}

/** A Turn was admitted to the Runtime queue without starting yet. */
export interface TurnQueued {
    readonly commandId: string;
    readonly kind: "turn.queued";
    readonly sessionId: string;
}

/** A Turn attempt finished executing on the Runtime. */
export interface TurnCompleted {
    readonly commandId: string;
    readonly kind: "turn.completed";
    readonly sessionId: string;
    readonly stopReason: string;
}

export type RuntimeControlResult =
    | RuntimeDiagnosticsResult
    | RuntimePongEvent
    | NativeSessionResult
    | SessionReadyEvent
    | SessionConfigUpdatedEvent
    | SessionRenamedEvent
    | SessionClosedEvent
    | TurnCompleted
    | TurnStarted
    | TurnQueued
    | SessionPreviewHistoryPageLoaded
    | SessionLiveHistoryV2PageLoaded
    | SessionElicitationResolvedEvent
    | SessionPermissionResolvedEvent
    | SessionsListedEvent
    | SessionsQueriedEvent
    | SessionRestoredEvent;

interface LifecycleExpectation {
    /** Resolve as soon as any of these V2 lifecycle kinds appears. */
    readonly resolveOn: readonly LifecycleMetadataV2["kind"][];
}

/** V2 lifecycle kinds that answer each Turn-shaped control command. */
function lifecycleExpectation(command: RuntimeControlCommand): LifecycleExpectation | null {
    if (command.kind === "session.prompt" || command.kind === "session.prompt.disposition") {
        return { resolveOn: ["prompt.started"] };
    }
    if (command.kind === "session.cancel") {
        return { resolveOn: ["prompt.completed"] };
    }
    if (command.kind === "session.permission.respond") {
        return { resolveOn: ["session.permission.resolved"] };
    }
    if (command.kind === "session.elicitation.respond") {
        return { resolveOn: ["session.elicitation.resolved"] };
    }
    return null;
}

type LifecycleReply =
    | { readonly kind: "resolve"; readonly result: RuntimeControlResult }
    | { readonly kind: "reject"; readonly error: SessionRuntimeError }
    | { readonly kind: "ignore" };

/** Maps one V2 lifecycle payload to the reply for the pending control command. */
function lifecycleReply(
    command: RuntimeControlCommand,
    expectation: LifecycleExpectation,
    requestId: string,
    sessionId: string,
    payload: LifecycleMetadataV2,
): LifecycleReply {
    // V2 envelopes are broadcast to every host socket, so only events carrying
    // this command's own identifiers answer it; other Turns' failures and
    // starts must leave the pending request waiting.
    if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
        if (payload.commandId !== requestId) {
            return { kind: "ignore" };
        }
        return { kind: "reject", error: new SessionRuntimeError(payload.code, payload.message) };
    }
    if (command.kind === "session.prompt" && payload.kind === "session.queue.changed") {
        // A queue change on the submitted Session acknowledges a queue-disposition
        // Turn: the daemon records it as the prompt enters its queue. The event is
        // Session-scoped, so this resolves submissions that asked to be queued;
        // every other disposition keeps waiting for its own prompt.started. A
        // queue-disposition Turn completing on the same Session also records a
        // queue change, so it can acknowledge a newer submission slightly early;
        // the response state is advisory while the Turn's own lifecycle events
        // remain authoritative for its outcome.
        if (command.disposition !== "queue" || sessionId !== command.sessionId) {
            return { kind: "ignore" };
        }
        return {
            kind: "resolve",
            result: {
                commandId: requestId,
                kind: "turn.queued",
                sessionId,
            },
        };
    }
    if (!expectation.resolveOn.includes(payload.kind)) {
        return { kind: "ignore" };
    }
    if (payload.kind === "prompt.started") {
        if (payload.commandId !== requestId) {
            return { kind: "ignore" };
        }
        return {
            kind: "resolve",
            result: {
                attemptId: payload.attemptId,
                commandId: payload.commandId,
                epoch: payload.epoch,
                kind: "turn.started",
                sessionId,
            },
        };
    }
    if (payload.kind === "prompt.completed") {
        if (payload.commandId !== requestId) {
            return { kind: "ignore" };
        }
        return {
            kind: "resolve",
            result: {
                commandId: payload.commandId,
                kind: "turn.completed",
                sessionId,
                stopReason: payload.stopReason,
            },
        };
    }
    if (payload.kind === "session.permission.resolved") {
        return payload.event.interactionId === requestId
            ? { kind: "resolve", result: payload.event }
            : { kind: "ignore" };
    }
    if (payload.kind === "session.elicitation.resolved") {
        return payload.event.interactionId === requestId
            ? { kind: "resolve", result: payload.event }
            : { kind: "ignore" };
    }
    return { kind: "ignore" };
}

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
                    const kind = decodeMessageKind(event.data);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(event.data).online) {
                            reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
                        }
                        return;
                    }
                    if (kind === "agent.settings.discovery.failed") {
                        const failed = decodeAgentSettingsDiscoveryFailedEvent(event.data);
                        if (failed.requestId === command.requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind !== "agent.settings.discovered") {
                        return;
                    }
                    const result = decodeAgentSettingsDiscoveredEvent(event.data);
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
                    if (decodeMessageKind(event.data) === SESSION_EVENT_V2_KIND) {
                        const expectation = lifecycleExpectation(command);
                        if (expectation === null) {
                            return;
                        }
                        for (const lifecycleEvent of decodeSessionEventEnvelopeV2(event.data).events) {
                            if (lifecycleEvent.type !== "lifecycle-metadata") {
                                continue;
                            }
                            const reply = lifecycleReply(
                                command,
                                expectation,
                                requestId,
                                lifecycleEvent.sessionId,
                                lifecycleEvent.payload,
                            );
                            if (reply.kind === "reject") {
                                reject(reply.error);
                                return;
                            }
                            if (reply.kind === "resolve") {
                                resolve(reply.result);
                                return;
                            }
                        }
                        return;
                    }
                    const kind = decodeMessageKind(event.data);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(event.data).online) {
                            reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
                        }
                        return;
                    }
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(event.data);
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
                        command.kind === "runtime.diagnostics.read" && kind === "runtime.diagnostics.result"
                            ? decodeRuntimeDiagnosticsResult(event.data)
                            : command.kind === "runtime.ping" && kind === "runtime.pong"
                              ? decodeRuntimePongEvent(event.data)
                              : command.kind === "native.session.request" && kind === "native.session.result"
                                ? decodeNativeSessionResult(event.data)
                                : command.kind === "session.list" && kind === "session.listed"
                                  ? decodeSessionsListedEvent(event.data)
                                  : command.kind === "session.query" && kind === "session.queried"
                                    ? decodeSessionsQueriedEvent(event.data)
                                    : command.kind === "session.restore" && kind === "session.restored"
                                      ? decodeSessionRestoredEvent(event.data)
                                      : command.kind === "session.close" && kind === "session.closed"
                                        ? decodeSessionClosedEvent(event.data)
                                        : command.kind === "session.prepare" && kind === "session.ready"
                                          ? decodeSessionReadyEvent(event.data)
                                          : command.kind === "session.configure" && kind === "session.config.updated"
                                            ? decodeSessionConfigUpdatedEvent(event.data)
                                            : command.kind === "session.rename" && kind === "session.renamed"
                                              ? decodeSessionRenamedEvent(event.data)
                                              : null;
                    const resolved =
                        result ??
                        (command.kind === "session.preview-history.page.load" &&
                        kind === "session.preview-history.page.loaded"
                            ? decodeSessionPreviewHistoryPageLoaded(event.data)
                            : command.kind === "session.live-history.v2.page.load" &&
                                kind === "session.live-history.v2.page.loaded"
                              ? decodeSessionLiveHistoryV2PageLoaded(event.data)
                              : command.kind === "session.permission.respond" && kind === "session.permission.resolved"
                                ? decodeSessionPermissionResolvedEvent(event.data)
                                : command.kind === "session.elicitation.respond" &&
                                    kind === "session.elicitation.resolved"
                                  ? decodeSessionElicitationResolvedEvent(event.data)
                                  : null);
                    if (
                        resolved !== null &&
                        (("requestId" in resolved && resolved.requestId === requestId) ||
                            ("interactionId" in resolved && resolved.interactionId === requestId))
                    ) {
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
                    const kind = decodeMessageKind(event.data);
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(event.data);
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
                    const result = decodeWorkspaceEntriesEvent(event.data);
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
