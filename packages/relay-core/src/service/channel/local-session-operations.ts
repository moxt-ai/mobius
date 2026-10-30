import type { ForkMobiusNativeSessionRequest } from "@moxt-ai/mobius-sdk";
import type {
    AgentSettingsDiscoverCommand,
    AgentSettingsDiscoveredEvent,
    WorkspaceEntriesEvent,
    WorkspaceListCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { decodeNativeSessionCancel } from "@moxt-ai/mobius-sdk/protocol";
import type { DurableObjectContext } from "../../di/create-durable-object-dependencies.ts";
import type { ProjectScope as Scope } from "../../entity/do/session.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { SessionRuntimeOperations } from "../../gateway/session-runtime-operations.ts";
import {
    requestRuntimeAgentSettings,
    requestRuntimeContentWrite,
    requestRuntimeControl,
    requestRuntimeFile,
    requestRuntimeWorkspace,
} from "../pairing/runtime-control-request.ts";
import type { NativeSessionForks } from "./native-session-forks.ts";

export interface LocalSessionOperations extends SessionRuntimeOperations {
    readonly forkNativeSession: (
        scope: Scope,
        runtimeId: string,
        operationId: string,
        input: ForkMobiusNativeSessionRequest,
        signal: AbortSignal,
    ) => ReturnType<NativeSessionForks["fork"]>;
    readonly requestWorkspace: (
        scope: Scope,
        runtimeId: string,
        command: WorkspaceListCommand,
        signal: AbortSignal,
    ) => Promise<WorkspaceEntriesEvent>;
    readonly requestAgentSettings: (
        scope: Scope,
        runtimeId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => Promise<AgentSettingsDiscoveredEvent>;
    readonly openPublicSessionEvents: (
        scope: Scope,
        runtimeId: string,
        sessionId: string,
        expiresAt: number,
        signal: AbortSignal,
    ) => Promise<Response>;
}

export function createLocalSessionOperations(
    cx: DurableObjectContext,
    projectId: string,
    runtimeId: string,
): LocalSessionOperations {
    const checkTarget = (requestedProject: string, requestedRuntime: string) => {
        const current = cx.services.connections.current();
        if (requestedProject !== projectId || requestedRuntime !== runtimeId || current?.runtimeId !== runtimeId) {
            throw new PairingDirectoryError("runtime_access_denied", "The selected Runtime is unavailable");
        }
        const daemon = cx.gateways.peers.sockets().find(({ identity }) => identity.role === "daemon");
        if (daemon !== undefined && daemon.identity.projectId !== projectId) {
            throw new PairingDirectoryError("runtime_access_denied", "The selected Runtime is unavailable");
        }
    };
    const connect = async (
        requestId: string,
        sessionId: string,
        queueAcknowledgement: boolean,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        await cx.services.runtime.expireSilentDaemons();
        return cx.gateways.requests.open(requestId, sessionId, queueAcknowledgement, async (socket, message) => {
            if (!signal.aborted) {
                await cx.services.runtime.receiveOperation(
                    new ProjectScope(projectId),
                    runtimeId,
                    socket,
                    message,
                    signal,
                );
                return;
            }
            // The caller has left, but native query cancellation must still reach the daemon.
            if (typeof message !== "string") {
                throw signal.reason;
            }
            const cancellation = decodeNativeSessionCancel(message);
            if (cancellation.requestId !== requestId) {
                throw signal.reason;
            }
            const cleanup = new AbortController();
            const timer = setTimeout(
                () => cleanup.abort(new DOMException("Cancellation timed out", "TimeoutError")),
                15_000,
            );
            try {
                await cx.services.runtime.receiveOperation(
                    new ProjectScope(projectId),
                    runtimeId,
                    socket,
                    message,
                    cleanup.signal,
                );
            } finally {
                clearTimeout(timer);
            }
        });
    };
    const requestProjectScopeControl: SessionRuntimeOperations["requestProjectScopeControl"] = async (
        scope,
        requestedRuntime,
        command,
        signal,
    ) => {
        checkTarget(scope.projectId, requestedRuntime);
        const id =
            "commandId" in command
                ? command.commandId
                : "interactionId" in command
                  ? command.interactionId
                  : command.requestId;
        const sessionId = "sessionId" in command ? command.sessionId : "";
        const socket = await connect(
            id,
            sessionId,
            command.kind === "session.prompt" && command.disposition === "queue",
            signal,
        );
        return await requestRuntimeControl(socket, command, signal, (query, querySignal) =>
            requestProjectScopeControl(scope, requestedRuntime, query, querySignal),
        );
    };
    return {
        forkNativeSession: async (scope, requestedRuntime, operationId, input, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            return await cx.services.nativeForks.fork(
                scope,
                requestedRuntime,
                operationId,
                input,
                requestProjectScopeControl,
                signal,
            );
        },
        requestWorkspace: async (scope, requestedRuntime, command, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            return await requestRuntimeWorkspace(await connect(command.requestId, "", false, signal), command, signal);
        },
        requestAgentSettings: async (scope, requestedRuntime, command, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            return await requestRuntimeAgentSettings(
                await connect(command.requestId, "", false, signal),
                command,
                signal,
            );
        },
        openPublicSessionEvents: async (scope, requestedRuntime, sessionId, expiresAt, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(scope.projectId, requestedRuntime);
            if (!cx.services.runtime.isOnline(runtimeId)) {
                throw new PairingDirectoryError("runtime_offline", "The Runtime is offline");
            }
            return cx.gateways.peers.accept({
                role: "viewer",
                projectId,
                runtimeId,
                sessionFilter: sessionId,
                expiresAt,
                eventFormat: "events",
            }).response;
        },
        requestProjectScopeControl,
        readProjectSessionFile: async (scope, requestedRuntime, command, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            const socket = await connect(command.requestId, command.sessionId, false, signal);
            try {
                const stream = await requestRuntimeFile(socket, command, signal);
                cx.utilities.waitUntil(stream.finished);
                return stream.response;
            } catch (cause) {
                socket.close(1000, "File request ended");
                throw cause;
            }
        },
        writeProjectSessionContent: async (scope, requestedRuntime, command, body, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            const socket = await connect(command.requestId, command.sessionId, false, signal);
            try {
                return await requestRuntimeContentWrite(socket, command, body, signal);
            } catch (cause) {
                socket.close(1000, "Content upload ended");
                throw cause;
            }
        },
        openProjectSessionEventHost: async (scope, requestedRuntime, sessionId, signal) => {
            checkTarget(scope.projectId, requestedRuntime);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(scope.projectId, requestedRuntime);
            const accepted = cx.gateways.peers.accept({
                role: "viewer",
                expiresAt: Number.MAX_SAFE_INTEGER,
                eventFormat: "envelope",
                projectId,
                runtimeId,
                sessionFilter: sessionId,
            });
            const socket = accepted.response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime is unavailable");
            }
            await cx.services.runtime.attachHost(runtimeId, scope, accepted.socket, signal);
            return {
                socket,
                close: async () => {
                    socket.close(1000, "Session subscription ended");
                },
            };
        },
    };
}
