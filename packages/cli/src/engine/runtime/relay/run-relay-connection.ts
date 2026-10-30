import {
    decodeKnownServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type RuntimeUpgradeResult,
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
    const relay = await connectRelay(relayUrl, signal, (failure, source) => {
        diagnostics.transportFailed(connectionEpoch, failure, source);
    });
    const { socket } = relay;
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
                    try {
                        commands.dispatchChunk(encoded);
                    } catch (error) {
                        failAndClose(
                            new Error("Relay sent an invalid content chunk", { cause: error }),
                            4008,
                            "Invalid content chunk",
                            "protocol",
                        );
                    }
                    return;
                }

                try {
                    const message = decodeKnownServiceToDaemonMessage(encoded);
                    if (message === null) {
                        diagnostics.daemonDiagnostic("protocol_message_discarded", "unknown", {
                            reason: "unsupported_message",
                        });
                        return;
                    }
                    const kind = message.kind;
                    if (kind === RUNTIME_LIVENESS_READY_KIND) {
                        if (ready) {
                            return;
                        }
                        ready = true;
                        publisher.connect(socket, { replay: message.sessionEventReplay === true });
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
        relay.release(new Error("Relay connection released"));
    }
}
