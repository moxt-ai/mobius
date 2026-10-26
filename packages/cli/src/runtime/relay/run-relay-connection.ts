import {
    decodeServiceToDaemonMessage,
    isIdentifier,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type RuntimeUpgradeResult,
    SESSION_OPERATION_FAILED_KIND,
    UnsupportedProtocolMessageKindError,
} from "@moxt-ai/mobius-sdk/protocol";
import { type MessageEvent, WebSocket } from "undici";
import type { ResolveAgent } from "../../session/api/session-api.ts";
import type { ExternalContentStore } from "../../session/content/external-content-store.ts";
import type { SessionManager } from "../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { PromptLifecycle } from "../../session/prompt/prompt-lifecycle.ts";
import type { ExecutionReceipts } from "../../session/turn/execution-receipts.ts";
import type { SessionTurns } from "../../session/turn/session-turns.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import { createRuntimeCommandDispatcher } from "../command/dispatcher.ts";
import { send } from "../command/transport.ts";
import type { RuntimeConfig } from "../config.ts";
import { connectRelay } from "./connect.ts";
import type { RelayConnectionDiagnostics } from "./diagnostics.ts";
import { RelayConnectionLiveness } from "./liveness.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./runtime-revocation.ts";
import type { RuntimeSessionEventPublisher } from "./session-event-publisher.ts";

function closeRelaySocket(socket: WebSocket, code: number, reason: string): void {
    try {
        socket.close(code, reason);
    } catch (error) {
        console.error("Mobius daemon could not close the Relay WebSocket", error);
        try {
            socket.close();
        } catch (fallbackError) {
            console.error("Mobius daemon could not release the Relay WebSocket", fallbackError);
        }
    }
}

interface RelayCommandCorrelation {
    readonly requestId: string;
    readonly sessionId: string;
}

/**
 * Reads correlation identifiers from a command the daemon rejected. The
 * message failed schema validation, so its fields are untrusted and are
 * echoed only when they already satisfy the identifier contract.
 */
function readCommandCorrelation(encoded: string): RelayCommandCorrelation {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        return { requestId: "unsupported", sessionId: "" };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { requestId: "unsupported", sessionId: "" };
    }
    const requestId = Reflect.get(value, "requestId");
    const sessionId = Reflect.get(value, "sessionId");
    return {
        requestId: typeof requestId === "string" && isIdentifier(requestId) ? requestId : "unsupported",
        sessionId: typeof sessionId === "string" && isIdentifier(sessionId) ? sessionId : "",
    };
}

/**
 * Answers a command kind this daemon does not implement. The connection stays
 * open for adjacent-version senders, but the caller learns immediately that
 * the operation will not run instead of waiting for its own deadline.
 */
function rejectUnsupportedCommand(
    socket: WebSocket,
    correlation: RelayCommandCorrelation,
    rejection: UnsupportedProtocolMessageKindError,
): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    send(socket, {
        code: rejection.code,
        kind: SESSION_OPERATION_FAILED_KIND,
        message: "The Relay sent a command this daemon does not support",
        requestId: correlation.requestId,
        sessionId: correlation.sessionId,
    });
}

export interface RelayConnectionOptions {
    readonly resolveAgent: ResolveAgent;
    readonly config: RuntimeConfig;
    /** Reports a finished daemon upgrade to the relay. The daemon worker supplies it. */
    readonly reportUpgradeAvailability: (
        send: (result: RuntimeUpgradeResult) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: ExecutionReceipts;
    readonly publisher: RuntimeSessionEventPublisher;
    readonly eventProjection: PromptLifecycle;
    readonly externalContent: ExternalContentStore;
    readonly sessionTurns: SessionTurns;
    readonly connectionEpoch: number;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly onConnected: () => void;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export async function runRelayConnection({
    resolveAgent,
    config,
    reportUpgradeAvailability,
    directories,
    sessionTurns,
    nativeSessions,
    operations,
    publisher,
    eventProjection,
    externalContent,
    sessions,
    connectionEpoch,
    diagnostics,
    onConnected,
    signal,
    timer,
}: RelayConnectionOptions): Promise<void> {
    const relayUrl = new URL(config.relayUrl);
    relayUrl.searchParams.set("liveness", "1");
    const socket = await connectRelay(relayUrl, signal);
    diagnostics.connectionOpened(connectionEpoch);
    const connectionController = new AbortController();
    const commands = createRuntimeCommandDispatcher({
        resolveAgent,
        config,
        directories,
        sessions,
        nativeSessions,
        operations,
        eventProjection,
        externalContent,
        sessionTurns,
        diagnostics,
        socket,
        signal: connectionController.signal,
        timer,
    });
    void reportUpgradeAvailability((result) => {
        if (socket.readyState === WebSocket.OPEN) {
            send(socket, result);
        }
    }, signal).catch((cause: unknown) => {
        if (!signal.aborted) {
            console.error("Could not report daemon upgrade", cause);
        }
    });

    try {
        await new Promise<void>((resolve, reject) => {
            let finished = false;
            let ready = false;

            const cleanup = (): void => {
                connectionLiveness.close();
                signal.removeEventListener("abort", stop);
                socket.removeEventListener("close", handleClose);
                socket.removeEventListener("error", handleError);
                socket.removeEventListener("message", handleMessage);
                publisher.disconnect(socket);
                connectionController.abort();
            };

            const resolveConnection = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                resolve();
            };

            const rejectConnection = (failure: Error): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                reject(failure);
            };

            const stop = (): void => {
                // A planned upgrade can follow the last completion before the batch timer fires.
                publisher.flush();
                diagnostics.connectionClosed(connectionEpoch, 1000, "Daemon stopped", "daemon_stop");
                closeRelaySocket(socket, 1000, "Daemon stopped");
                resolveConnection();
            };

            const failAndClose = (failure: Error, code: number, reason: string, source: string): void => {
                diagnostics.connectionFailed(connectionEpoch, failure, source);
                diagnostics.connectionClosed(connectionEpoch, code, reason, source);
                closeRelaySocket(socket, code, reason);
                rejectConnection(failure);
            };

            const connectionLiveness = new RelayConnectionLiveness(timer, {
                send: (message) => {
                    if (socket.readyState !== WebSocket.OPEN) {
                        return false;
                    }
                    try {
                        send(socket, message);
                        return true;
                    } catch (error) {
                        if (socket.readyState !== WebSocket.OPEN) {
                            return false;
                        }
                        throw error;
                    }
                },
                unresponsive: (timeoutMilliseconds) => {
                    diagnostics.heartbeatTimedOut(connectionEpoch, timeoutMilliseconds);
                    diagnostics.connectionClosed(
                        connectionEpoch,
                        4001,
                        "Relay liveness check timed out",
                        "heartbeat_timeout",
                    );
                    closeRelaySocket(socket, 4001, "Relay liveness check timed out");
                    resolveConnection();
                },
            });

            signal.addEventListener("abort", stop, { once: true });
            const handleClose = (event: CloseEvent): void => {
                diagnostics.connectionClosed(connectionEpoch, event.code, event.reason, "relay");
                if (isRuntimeRelayRevocation(event.code, event.reason)) {
                    rejectConnection(new RuntimeRelayRevokedError(event.code, event.reason));
                    return;
                }
                resolveConnection();
            };
            const handleError = (event: Event): void => {
                if (signal.aborted) {
                    resolveConnection();
                    return;
                }
                const cause = Reflect.get(event, "error");
                const failure = new Error("Relay WebSocket emitted an error", { cause: cause ?? event });
                diagnostics.connectionFailed(connectionEpoch, failure, "socket_error");
                diagnostics.connectionClosed(connectionEpoch, 1006, "WebSocket error", "socket_error");
                rejectConnection(failure);
            };
            const handleMessage = (event: MessageEvent<unknown>): void => {
                const encoded: unknown = event.data;
                if (typeof encoded !== "string") {
                    failAndClose(new Error("Relay sent a non-text message"), 4003, "Text message required", "protocol");
                    return;
                }

                try {
                    const message = decodeServiceToDaemonMessage(encoded);
                    const kind = message.kind;
                    if (kind === RUNTIME_LIVENESS_READY_KIND) {
                        if (ready) {
                            return;
                        }
                        ready = true;
                        publisher.connect(socket);
                        connectionLiveness.start();
                        onConnected();
                        return;
                    }
                    if (kind === RUNTIME_HEARTBEAT_ACK_KIND) {
                        connectionLiveness.acknowledge();
                        return;
                    }
                    commands.dispatch(message);
                } catch (error) {
                    if (error instanceof UnsupportedProtocolMessageKindError) {
                        const correlation = readCommandCorrelation(encoded);
                        console.warn("Mobius daemon rejected an unsupported Relay command", {
                            code: error.code,
                            direction: error.direction,
                            messageKind: error.messageKind,
                        });
                        diagnostics.daemonDiagnostic(
                            "relay_command_unsupported",
                            correlation.requestId,
                            {
                                code: error.code,
                                direction: error.direction,
                                messageKind: error.messageKind,
                            },
                            error,
                        );
                        rejectUnsupportedCommand(socket, correlation, error);
                        return;
                    }
                    console.error("Mobius daemon rejected a message", error);
                    failAndClose(
                        new Error("Relay sent an invalid protocol message", { cause: error }),
                        4008,
                        "Invalid protocol message",
                        "protocol",
                    );
                }
            };
            socket.addEventListener("close", handleClose);
            socket.addEventListener("error", handleError);
            socket.addEventListener("message", handleMessage);

            if (signal.aborted) {
                stop();
            }
        });
    } finally {
        connectionController.abort();
        await commands.settle();
    }
}
