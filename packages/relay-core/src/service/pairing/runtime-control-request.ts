import {
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    CONTENT_AVAILABLE_KIND,
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_READY_KIND,
    type ContentAvailableEvent,
    type ContentWriteCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeContentAvailableEvent,
    decodeContentChunkFrame,
    decodeContentReadyEvent,
    decodeFileBeginEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    decodeWorkspaceEntriesEvent,
    encodeContentChunkFrame,
    encodeNativeSessionRequest,
    encodeServiceToDaemonMessage,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    type FileReadCommand,
    type LifecycleMetadata,
    type NativeSessionRequest,
    type NativeSessionResult,
    type RuntimeDiagnosticsRequest,
    type RuntimeDiagnosticsResult,
    type RuntimePingCommand,
    type RuntimePongEvent,
    SESSION_EVENT_KIND,
    type SessionCancelBeforeStartCommand,
    type SessionCancelCommand,
    type SessionCloseCommand,
    type SessionClosedEvent,
    type SessionConfigReadCommand,
    type SessionConfigReadResult,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionElicitationResolvedEvent,
    type SessionElicitationRespondCommand,
    type SessionHistoryPageLoad,
    type SessionHistoryPageLoaded,
    type SessionListCommand,
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
} from "@moxt-ai/mobius-sdk/protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import { runtimeControlRegistry } from "./runtime-control-registry.ts";

export interface RuntimeReplyConnection {
    readonly readyState: number;
    readonly accept: () => void;
    readonly send: (message: string | ArrayBuffer | ArrayBufferView) => void;
    readonly close: (code?: number, reason?: string) => void;
    readonly addEventListener: EventTarget["addEventListener"];
    readonly removeEventListener: EventTarget["removeEventListener"];
}

export type RuntimeControlCommand =
    | RuntimeDiagnosticsRequest
    | RuntimePingCommand
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionConfigureCommand
    | SessionConfigReadCommand
    | SessionRenameCommand
    | SessionCloseCommand
    | SessionCancelBeforeStartCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionPreviewHistoryPageLoad
    | SessionHistoryPageLoad
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
    | SessionConfigReadResult
    | SessionRenamedEvent
    | SessionClosedEvent
    | TurnCompleted
    | TurnStarted
    | TurnQueued
    | SessionPreviewHistoryPageLoaded
    | SessionHistoryPageLoaded
    | SessionElicitationResolvedEvent
    | SessionPermissionResolvedEvent
    | SessionsListedEvent
    | SessionsQueriedEvent
    | SessionRestoredEvent;

interface LifecycleExpectation {
    /** Resolve as soon as any of these V2 lifecycle kinds appears. */
    readonly resolveOn: readonly LifecycleMetadata["kind"][];
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
    payload: LifecycleMetadata,
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

export async function requestRuntimeContentWrite(
    socket: RuntimeReplyConnection,
    command: ContentWriteCommand,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
): Promise<ContentAvailableEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Runtime content upload timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    let uploadStarted = false;
    let upload: Promise<void> = Promise.resolve();
    try {
        return await new Promise<ContentAvailableEvent>((resolve, reject) => {
            const fail = (cause: unknown): void => reject(cause);
            const onClose = (): void =>
                fail(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = (): void => fail(deadline.reason);
            const sendBody = async (): Promise<void> => {
                const reader = body.getReader();
                let sequence = 0;
                let sentBytes = 0;
                try {
                    while (true) {
                        deadline.throwIfAborted();
                        const chunk = await reader.read();
                        if (chunk.done) {
                            break;
                        }
                        for (let offset = 0; offset < chunk.value.byteLength; offset += CONTENT_CHUNK_MAX_BYTES) {
                            const bytes = chunk.value.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES);
                            sentBytes += bytes.byteLength;
                            if (sentBytes > command.byteLength) {
                                throw new SessionRuntimeError(
                                    "invalid_request",
                                    "The content body exceeds its declared size",
                                );
                            }
                            socket.send(encodeContentChunkFrame({ bytes, requestId: command.requestId, sequence }));
                            sequence += 1;
                        }
                    }
                    if (sentBytes !== command.byteLength) {
                        throw new SessionRuntimeError("invalid_request", "The content body has an unexpected size");
                    }
                    socket.send(
                        encodeServiceToDaemonMessage({
                            kind: "content.commit",
                            requestId: command.requestId,
                            sessionId: command.sessionId,
                        }),
                    );
                } finally {
                    reader.releaseLock();
                }
            };
            const onMessage = (event: Event): void => {
                if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
                    return;
                }
                try {
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
                    if (kind === CONTENT_READY_KIND) {
                        const ready = decodeContentReadyEvent(event.data);
                        if (ready.requestId !== command.requestId || uploadStarted) {
                            return;
                        }
                        uploadStarted = true;
                        upload = sendBody().catch(fail);
                        return;
                    }
                    if (kind === CONTENT_AVAILABLE_KIND) {
                        const available = decodeContentAvailableEvent(event.data);
                        if (
                            available.requestId !== command.requestId ||
                            available.contentKey !== command.contentKey ||
                            available.byteLength !== command.byteLength
                        ) {
                            throw new SessionRuntimeError(
                                "invalid_request",
                                "The Runtime returned invalid content metadata",
                            );
                        }
                        resolve(available);
                    }
                } catch (cause) {
                    fail(cause);
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
    } finally {
        clearTimeout(timer);
        cleanup();
        await upload.catch(() => undefined);
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeFile(
    socket: RuntimeReplyConnection,
    command: FileReadCommand,
    signal: AbortSignal,
): Promise<RuntimeFileStream> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Runtime request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
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
            clearTimeout(timer);
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
        const onMessage = (event: Event): void => {
            if (!(event instanceof MessageEvent)) {
                return;
            }
            try {
                if (typeof event.data !== "string") {
                    const chunk = decodeContentChunkFrame(event.data);
                    if (chunk.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || chunk.sequence !== nextSequence) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime returned invalid file chunks");
                    }
                    receivedBytes += chunk.bytes.byteLength;
                    if (receivedBytes > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Runtime exceeded the file size limit");
                    }
                    nextSequence += 1;
                    stream?.enqueue(chunk.bytes);
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
    socket: RuntimeReplyConnection,
    command: AgentSettingsDiscoverCommand,
    signal: AbortSignal,
): Promise<AgentSettingsDiscoveredEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Runtime request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<AgentSettingsDiscoveredEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
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
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeControl(
    socket: RuntimeReplyConnection,
    command: RuntimeControlCommand,
    signal: AbortSignal,
): Promise<RuntimeControlResult> {
    const { reply } = runtimeControlRegistry[command.kind];
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Runtime request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    const requestId =
        command.kind === "session.prompt" ||
        command.kind === "session.prompt.disposition" ||
        command.kind === "session.cancel" ||
        command.kind === "session.cancel-before-start"
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
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const kind = decodeMessageKind(event.data);
                    if (kind === SESSION_EVENT_KIND) {
                        if (reply.kind !== "lifecycle") {
                            return;
                        }
                        for (const lifecycleEvent of decodeSessionEventEnvelope(event.data).events) {
                            if (lifecycleEvent.type !== "lifecycle-metadata") {
                                continue;
                            }
                            const lifecycle = lifecycleReply(
                                command,
                                reply,
                                requestId,
                                lifecycleEvent.sessionId,
                                lifecycleEvent.payload,
                            );
                            if (lifecycle.kind === "reject") {
                                reject(lifecycle.error);
                                return;
                            }
                            if (lifecycle.kind === "resolve") {
                                resolve(lifecycle.result);
                                return;
                            }
                        }
                        return;
                    }
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
                    const direct = reply.kind === "direct" ? reply : reply.direct;
                    if (direct === null || kind !== direct.eventKind) {
                        return;
                    }
                    const resolved = direct.decode(event.data);
                    if (
                        ("requestId" in resolved && resolved.requestId === requestId) ||
                        ("interactionId" in resolved && resolved.interactionId === requestId)
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
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestRuntimeWorkspace(
    socket: RuntimeReplyConnection,
    command: WorkspaceListCommand,
    signal: AbortSignal,
): Promise<WorkspaceEntriesEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Runtime request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<WorkspaceEntriesEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
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
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}
