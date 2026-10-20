import {
    decodeServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    UnsupportedProtocolMessageKindError,
} from "@moxt-ai/mobius-sdk/protocol";
import { type MessageEvent, WebSocket } from "undici";
import type { AgentRuntimeManager } from "../../acp/agent-runtime-manager.ts";
import type { WorkspaceDirectoryService } from "../../authorization/workspace-directory.ts";
import { reportDaemonUpgradeAvailability } from "../../daemon/upgrades/upgrade.ts";
import type { ExternalContentStore } from "../../external-content/local-external-content-store.ts";
import type { NativeSessionService } from "../../native-sessions/service.ts";
import type { RuntimeSessionEventProjection } from "../../session-event-projection.ts";
import type { RuntimeOperationState } from "../admission.ts";
import { createRuntimeCommandDispatcher, send } from "../command/dispatcher.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RuntimeTurnRegistry } from "../session/turn/turn-registry.ts";
import { connectRelay } from "./connect.ts";
import type { RelayConnectionDiagnostics } from "./diagnostics.ts";
import { RelayConnectionLiveness } from "./liveness.ts";
import { isRuntimeRelayRevocation, RuntimeRelayRevokedError } from "./runtime-revocation.ts";
import type { RuntimeSessionEventPublisher } from "./session-event-publisher.ts";
import type { Timer } from "./timer.ts";

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
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: RuntimeOperationState;
    readonly publisher: RuntimeSessionEventPublisher;
    readonly eventProjection: RuntimeSessionEventProjection;
    readonly externalContent: ExternalContentStore;
    readonly activeTurns: RuntimeTurnRegistry;
    readonly connectionEpoch: number;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly onConnected: () => void;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export async function runRelayConnection({
    config,
    directories,
    sessions,
    nativeSessions,
    operations,
    publisher,
    eventProjection,
    externalContent,
    activeTurns,
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
        config,
        directories,
        sessions,
        nativeSessions,
        operations,
        eventProjection,
        externalContent,
        activeTurns,
        diagnostics,
        socket,
        signal: connectionController.signal,
        timer,
    });
    void reportDaemonUpgradeAvailability((result) => {
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
                unresponsive: (heartbeatId, timeoutMilliseconds) => {
                    diagnostics.heartbeatTimedOut(connectionEpoch, heartbeatId, timeoutMilliseconds);
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
                        connectionLiveness.acknowledge(message);
                        return;
                    }
                    commands.dispatch(message);
                } catch (error) {
                    if (error instanceof UnsupportedProtocolMessageKindError) {
                        console.warn("Mobius daemon skipped an unsupported Relay message", {
                            code: error.code,
                            direction: error.direction,
                            messageKind: error.messageKind,
                        });
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
