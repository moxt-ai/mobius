import {
    NATIVE_SESSION_REQUEST_KIND,
    type NativeSessionCancel,
    type NativeSessionCommand,
    type NativeSessionTurnForkCommand,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import { AcpExecutionError } from "../acp/session-manager.ts";
import type { AuditStore } from "../audit/audit-store.ts";
import { operationErrorCode, reportOperationFailure, send } from "../daemon-session-commands.ts";
import type { RelayConnectionDiagnostics } from "../relay-connection/diagnostics.ts";
import type { DaemonTimer } from "../relay-connection/timer.ts";
import type { NativeSessionService } from "./service.ts";

type NativeCommand = NativeSessionCommand | NativeSessionTurnForkCommand;

type PendingRequest = Readonly<{
    agentId: string;
    sessionId: string;
    controller: AbortController;
    completion: Promise<void>;
}>;

interface NativeRequestDependencies {
    readonly audit: AuditStore;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly nativeSessions: NativeSessionService;
    readonly signal: AbortSignal;
    readonly socket: WebSocket;
    readonly timer: DaemonTimer;
}

export function createNativeSessionRequestHandler(dependencies: NativeRequestDependencies) {
    const { audit, diagnostics, nativeSessions, signal, socket, timer } = dependencies;
    const pending = new Map<string, PendingRequest>();

    const cancel = (command: NativeSessionCancel): void => {
        const request = pending.get(command.requestId);
        if (request?.sessionId === command.sessionId) {
            request.controller.abort(
                new AcpExecutionError("Native session operation cancelled", {}, "native_session_cancelled"),
            );
        }
    };

    const handle = (command: NativeCommand): void => {
        const previous = [...pending.values()].filter((request) => request.agentId === command.agentId);
        const parallelRead =
            command.kind === NATIVE_SESSION_REQUEST_KIND &&
            (command.action === "linked-history" || command.action === "active-turn");
        if (
            pending.has(command.requestId) ||
            pending.size >= 4 ||
            (!parallelRead && previous.some((request) => !request.controller.signal.aborted))
        ) {
            reportOperationFailure(
                socket,
                command.requestId,
                command.sessionId,
                new AcpExecutionError("Another native session operation is running", {}, "native_session_busy"),
            );
            return;
        }

        const controller = new AbortController();
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () =>
                controller.abort(
                    new AcpExecutionError("Native session operation timed out", {}, "native_session_timeout"),
                ),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                operationSignal.throwIfAborted();
                const skipPrevious = command.kind === NATIVE_SESSION_REQUEST_KIND && command.action === "active-turn";
                if (previous.length > 0 && !skipPrevious) {
                    await new Promise<void>((resolve, reject) => {
                        const onAbort = (): void => reject(operationSignal.reason);
                        operationSignal.addEventListener("abort", onAbort, { once: true });
                        void Promise.all(previous.map((request) => request.completion)).then(
                            () => {
                                operationSignal.removeEventListener("abort", onAbort);
                                resolve();
                            },
                            (error: unknown) => {
                                operationSignal.removeEventListener("abort", onAbort);
                                reject(error);
                            },
                        );
                    });
                }
                operationSignal.throwIfAborted();
                const result =
                    command.kind === NATIVE_SESSION_REQUEST_KIND
                        ? await nativeSessions.execute(command, operationSignal)
                        : await nativeSessions.executeTurnFork(command, operationSignal);
                if (socket.readyState === WebSocket.OPEN) {
                    send(socket, result);
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new AcpExecutionError("Native session operation cancelled", {}, "native_session_cancelled"))
                    : error;
                const event =
                    command.kind === NATIVE_SESSION_REQUEST_KIND
                        ? "native_session_operation_failed"
                        : "native_session_turn_fork_failed";
                audit.record({
                    commandId: command.requestId,
                    sessionId: command.sessionId,
                    event,
                    details: { code: operationErrorCode(failure) },
                });
                diagnostics.daemonDiagnostic(
                    event,
                    command.requestId,
                    {
                        ...(command.kind === NATIVE_SESSION_REQUEST_KIND ? { action: command.action } : {}),
                        agentId: command.agentId,
                        code: operationErrorCode(failure),
                        sessionId: command.sessionId,
                    },
                    failure,
                );
                reportOperationFailure(socket, command.requestId, command.sessionId, failure);
            } finally {
                timeout.cancel();
                pending.delete(command.requestId);
            }
        })();
        pending.set(command.requestId, {
            agentId: command.agentId,
            sessionId: command.sessionId,
            controller,
            completion,
        });
    };

    const settle = async (): Promise<void> => {
        await Promise.all([...pending.values()].map((request) => request.completion));
    };

    return { cancel, handle, settle };
}
