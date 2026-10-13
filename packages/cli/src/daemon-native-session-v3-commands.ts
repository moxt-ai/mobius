import type {
    SessionHistoryPageLoadV3,
    SessionPermissionResponseV3,
    SessionSettingChangeV3,
    SessionSettingsReadV3,
    SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";
import { SESSION_HISTORY_V3_PAGE_LOADED_KIND, SESSION_SETTINGS_V3_LOADED_KIND } from "@moxt-ai/mobius-protocol";
import type { WebSocket } from "undici";
import type { AuditStore } from "./audit/audit-store.ts";
import { operationErrorCode, reportOperationFailure, send } from "./daemon-command-results.ts";
import type { NativeSessionRuntimeManagerV3 } from "./native-sessions/runtime-manager-v3.ts";
import type { RelayConnectionDiagnostics } from "./relay-connection/diagnostics.ts";

interface SessionV3Command {
    readonly requestId: string;
    readonly sessionId: string;
}

async function executeConnectedOperationV3(
    socket: WebSocket,
    command: SessionV3Command,
    operation: () => Promise<void>,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    try {
        signal.throwIfAborted();
        await operation();
        signal.throwIfAborted();
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        const code = operationErrorCode(error);
        diagnostics.daemonDiagnostic(
            "native_session_v3_operation_failed",
            command.requestId,
            { code, sessionId: command.sessionId },
            error,
        );
        audit.record({
            commandId: command.requestId,
            details: { code },
            event: "native_session_v3_operation_failed",
            sessionId: command.sessionId,
        });
        reportOperationFailure(socket, command.requestId, command.sessionId, error);
    }
}

export async function executeSessionHistoryPageLoadV3(
    socket: WebSocket,
    command: SessionHistoryPageLoadV3,
    nativeSessions: NativeSessionRuntimeManagerV3,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    await executeConnectedOperationV3(
        socket,
        command,
        async () => {
            const page = await nativeSessions.connected(command.sessionId).pageMessages(command, signal);
            send(socket, {
                kind: SESSION_HISTORY_V3_PAGE_LOADED_KIND,
                page,
                requestId: command.requestId,
                sessionId: command.sessionId,
            });
            audit.record({
                commandId: command.requestId,
                event: "session_history_v3_loaded",
                sessionId: command.sessionId,
            });
        },
        audit,
        diagnostics,
        signal,
    );
}

export async function executeSessionSettingsReadV3(
    socket: WebSocket,
    command: SessionSettingsReadV3,
    nativeSessions: NativeSessionRuntimeManagerV3,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    await executeConnectedOperationV3(
        socket,
        command,
        async () => {
            const settings = await nativeSessions.connected(command.sessionId).readSettings(signal);
            send(socket, {
                kind: SESSION_SETTINGS_V3_LOADED_KIND,
                requestId: command.requestId,
                sessionId: command.sessionId,
                settings,
            });
            audit.record({
                commandId: command.requestId,
                event: "session_settings_v3_loaded",
                sessionId: command.sessionId,
            });
        },
        audit,
        diagnostics,
        signal,
    );
}

export async function executeSessionSettingChangeV3(
    socket: WebSocket,
    command: SessionSettingChangeV3,
    nativeSessions: NativeSessionRuntimeManagerV3,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    await executeConnectedOperationV3(
        socket,
        command,
        async () => {
            const settings = await nativeSessions.connected(command.sessionId).applySetting(command, signal);
            await nativeSessions
                .live(command.sessionId)
                .publish({ sessionUpdate: "session_settings_changed", settings });
            send(socket, {
                kind: SESSION_SETTINGS_V3_LOADED_KIND,
                requestId: command.requestId,
                sessionId: command.sessionId,
                settings,
            });
            audit.record({
                commandId: command.requestId,
                event: "session_setting_v3_changed",
                sessionId: command.sessionId,
            });
        },
        audit,
        diagnostics,
        signal,
    );
}

export async function executeSessionPermissionResponseV3(
    socket: WebSocket,
    command: SessionPermissionResponseV3,
    nativeSessions: NativeSessionRuntimeManagerV3,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    await executeConnectedOperationV3(
        socket,
        command,
        async () => {
            await nativeSessions.connected(command.sessionId).respondPermission(command, signal);
            audit.record({
                commandId: command.requestId,
                event: "session_permission_v3_responded",
                sessionId: command.sessionId,
            });
        },
        audit,
        diagnostics,
        signal,
    );
}

export async function executeSessionUserInputResponseV3(
    socket: WebSocket,
    command: SessionUserInputResponseV3,
    nativeSessions: NativeSessionRuntimeManagerV3,
    audit: AuditStore,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    await executeConnectedOperationV3(
        socket,
        command,
        async () => {
            await nativeSessions.connected(command.sessionId).respondUserInput(command, signal);
            audit.record({
                commandId: command.requestId,
                event: "session_user_input_v3_responded",
                sessionId: command.sessionId,
            });
        },
        audit,
        diagnostics,
        signal,
    );
}
