import type { NativeSessionCancel, NativeSessionCommand } from "@moxt-ai/mobius-sdk/protocol";
import { operationErrorCode } from "../../infra/operation-error.ts";
import { SessionError } from "../../session/api/session-error.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { Timer } from "../../util/timer.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { RuntimeCommandTransport } from "./transport.ts";
import { reportOperationFailure, send } from "./transport.ts";

type PendingRequest = Readonly<{
    agentId: string;
    sessionId: string;
    controller: AbortController;
    completion: Promise<void>;
}>;

interface NativeRequestDependencies {
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly nativeSessions: NativeSessionService;
    readonly signal: AbortSignal;
    readonly transport: RuntimeCommandTransport;
    readonly timer: Timer;
}

export function createNativeSessionRequestHandler(dependencies: NativeRequestDependencies) {
    const { diagnostics, nativeSessions, signal, transport, timer } = dependencies;
    const pending = new Map<string, PendingRequest>();

    const cancel = (command: NativeSessionCancel): void => {
        const request = pending.get(command.requestId);
        if (request?.sessionId === command.sessionId) {
            request.controller.abort(
                new SessionError("native_session_cancelled", "Native session operation cancelled"),
            );
        }
    };

    const handle = (command: NativeSessionCommand): void => {
        const previous = [...pending.values()].filter((request) => request.agentId === command.agentId);
        const parallelRead = command.action === "active-turn";
        if (
            pending.has(command.requestId) ||
            pending.size >= 4 ||
            (!parallelRead && previous.some((request) => !request.controller.signal.aborted))
        ) {
            reportOperationFailure(
                transport,
                command.requestId,
                command.sessionId,
                new SessionError("native_session_busy", "Another native session operation is running"),
            );
            return;
        }

        const controller = new AbortController();
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () => controller.abort(new SessionError("native_session_timeout", "Native session operation timed out")),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                operationSignal.throwIfAborted();
                const skipPrevious = command.action === "active-turn";
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
                const result = await nativeSessions.execute(command, operationSignal);
                if (transport.isOpen()) {
                    send(transport, result);
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new SessionError("native_session_cancelled", "Native session operation cancelled"))
                    : error;
                const event = "native_session_operation_failed";
                diagnostics.daemonDiagnostic(
                    event,
                    command.requestId,
                    {
                        action: command.action,
                        agentId: command.agentId,
                        code: operationErrorCode(failure),
                        sessionId: command.sessionId,
                    },
                    failure,
                );
                reportOperationFailure(transport, command.requestId, command.sessionId, failure);
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
