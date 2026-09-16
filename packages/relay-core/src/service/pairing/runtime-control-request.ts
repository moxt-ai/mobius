import {
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRuntimeStatusEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionFailedEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    encodeNativeSessionCancel,
    type NativeSessionCommand,
    type NativeSessionResult,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionPrepareCommand,
    type SessionReadyEvent,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";

export type RuntimeControlCommand = NativeSessionCommand | SessionPrepareCommand | SessionConfigureCommand;
export type RuntimeControlResult = NativeSessionResult | SessionReadyEvent | SessionConfigUpdatedEvent;

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
                        decodeMessageKind(event.data) === "session.event.committed"
                            ? decodeCommittedSessionEvent(event.data).payload
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
            socket.send(JSON.stringify(command));
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
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<RuntimeControlResult>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("runtime_offline", "The Runtime connection closed"));
            const onAbort = () => {
                if (command.kind === "native.session.request" && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        encodeNativeSessionCancel({
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
                        decodeMessageKind(event.data) === "session.event.committed"
                            ? decodeCommittedSessionEvent(event.data).payload
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
                    const result =
                        kind === "native.session.result"
                            ? decodeNativeSessionResult(raw)
                            : kind === "session.ready"
                              ? decodeSessionReadyEvent(raw)
                              : kind === "session.config.updated"
                                ? decodeSessionConfigUpdatedEvent(raw)
                                : null;
                    if (result !== null && result.requestId === command.requestId) {
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
            socket.send(JSON.stringify(command));
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
                        decodeMessageKind(event.data) === "session.event.committed"
                            ? decodeCommittedSessionEvent(event.data).payload
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
            socket.send(JSON.stringify(command));
        });
    } finally {
        cleanup();
        socket.close(1000, "Operation finished");
    }
}
