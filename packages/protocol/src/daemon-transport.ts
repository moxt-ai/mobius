import {
    decodeMessageKind,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeRuntimePingCommand,
    decodeRuntimePongEvent,
    decodeSessionCancelCommand,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueuedEvent,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeHeartbeatEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeRuntimePingCommand,
    encodeRuntimePongEvent,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    encodeSessionQueuedEvent,
    UnsupportedProtocolMessageKindError,
} from "./codecs/messages.ts";
import {
    AGENT_INSTALL_CANCEL_KIND,
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    decodeAgentInstallCancelCommand,
    decodeAgentInstallCancelledEvent,
    decodeAgentInstallCompletedEvent,
    decodeAgentInstallFailedEvent,
    decodeAgentInstallProgressEvent,
    decodeAgentInstallRequestCommand,
    decodeAgentInstallStartedEvent,
    decodeAgentSettingsDiscoverCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeFileReadCommand,
    decodeSessionCloseCommand,
    decodeSessionClosedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionInfoUpdatedEvent,
    decodeSessionListCommand,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionQueryCommand,
    decodeSessionReadyEvent,
    decodeSessionRestoreCommand,
    decodeSessionRestoredEvent,
    decodeSessionStatusChangedEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceEntriesEvent,
    decodeWorkspaceListCommand,
    encodeAgentInstallCancelCommand,
    encodeAgentInstallCancelledEvent,
    encodeAgentInstallCompletedEvent,
    encodeAgentInstallFailedEvent,
    encodeAgentInstallProgressEvent,
    encodeAgentInstallRequestCommand,
    encodeAgentInstallStartedEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeAgentSettingsDiscoveredEvent,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeFileBeginEvent,
    encodeFileChunkEvent,
    encodeFileEndEvent,
    encodeFileFailedEvent,
    encodeFileReadCommand,
    encodeSessionCloseCommand,
    encodeSessionClosedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionInfoUpdatedEvent,
    encodeSessionListCommand,
    encodeSessionOperationFailedEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionQueryCommand,
    encodeSessionReadyEvent,
    encodeSessionRestoreCommand,
    encodeSessionRestoredEvent,
    encodeSessionStatusChangedEvent,
    encodeSessionsListedEvent,
    encodeSessionsQueriedEvent,
    encodeWorkspaceEntriesEvent,
    encodeWorkspaceListCommand,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORE_KIND,
    SESSION_RESTORED_KIND,
    SESSION_STATUS_CHANGED_KIND,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "./control-messages.ts";
import {
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUEUED_KIND,
} from "./messages.ts";
import {
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    encodeNativeSessionCancel,
    encodeNativeSessionCommand,
    encodeNativeSessionResult,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
} from "./native-sessions.ts";
import {
    decodeRuntimeDiagnosticsRequest,
    decodeRuntimeDiagnosticsResult,
    encodeRuntimeDiagnosticsRequest,
    encodeRuntimeDiagnosticsResult,
} from "./runtime-diagnostics.ts";
import { decodeRuntimeUpgradeResult, encodeRuntimeUpgradeResult } from "./runtime-upgrade.ts";
import {
    decodeSessionEventEnvelopeV2,
    encodeSessionEventEnvelopeV2,
    SESSION_EVENT_V2_KIND,
} from "./session-event-log-v2.ts";
import {
    decodeSessionLiveHistoryV2PageLoad,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionLiveHistoryV2PageLoaded,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoaded,
    SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
} from "./session-live-history.ts";

interface MessageSignature<TMessage extends { readonly kind: string }> {
    readonly decoder: (encoded: string) => TMessage;
    readonly encoder: (message: unknown) => string;
    readonly kind: TMessage["kind"];
    readonly schema: (message: unknown) => TMessage;
}

function defineMessageSignature<TMessage extends { readonly kind: string }>(
    kind: TMessage["kind"],
    encoder: (message: TMessage) => string,
    decoder: (encoded: string) => TMessage,
): MessageSignature<TMessage> {
    const schema = (message: unknown): TMessage => decoder(JSON.stringify(message));
    return {
        decoder,
        encoder: (message) => encoder(schema(message)),
        kind,
        schema,
    };
}

const serviceToDaemonSignatures = {
    [SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature(
        SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
        encodeSessionPreviewHistoryPageLoad,
        decodeSessionPreviewHistoryPageLoad,
    ),
    [AGENT_INSTALL_CANCEL_KIND]: defineMessageSignature(
        AGENT_INSTALL_CANCEL_KIND,
        encodeAgentInstallCancelCommand,
        decodeAgentInstallCancelCommand,
    ),
    [AGENT_INSTALL_REQUEST_KIND]: defineMessageSignature(
        AGENT_INSTALL_REQUEST_KIND,
        encodeAgentInstallRequestCommand,
        decodeAgentInstallRequestCommand,
    ),
    [AGENT_SETTINGS_DISCOVER_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVER_KIND,
        encodeAgentSettingsDiscoverCommand,
        decodeAgentSettingsDiscoverCommand,
    ),
    [FILE_READ_KIND]: defineMessageSignature(FILE_READ_KIND, encodeFileReadCommand, decodeFileReadCommand),
    [SESSION_LIST_KIND]: defineMessageSignature(SESSION_LIST_KIND, encodeSessionListCommand, decodeSessionListCommand),
    [SESSION_QUERY_KIND]: defineMessageSignature(
        SESSION_QUERY_KIND,
        encodeSessionQueryCommand,
        decodeSessionQueryCommand,
    ),
    [SESSION_RESTORE_KIND]: defineMessageSignature(
        SESSION_RESTORE_KIND,
        encodeSessionRestoreCommand,
        decodeSessionRestoreCommand,
    ),
    [SESSION_CLOSE_KIND]: defineMessageSignature(
        SESSION_CLOSE_KIND,
        encodeSessionCloseCommand,
        decodeSessionCloseCommand,
    ),
    [NATIVE_SESSION_CANCEL_KIND]: defineMessageSignature(
        NATIVE_SESSION_CANCEL_KIND,
        encodeNativeSessionCancel,
        decodeNativeSessionCancel,
    ),
    [NATIVE_SESSION_REQUEST_KIND]: defineMessageSignature(
        NATIVE_SESSION_REQUEST_KIND,
        encodeNativeSessionCommand,
        decodeNativeSessionCommand,
    ),
    [RUNTIME_HEARTBEAT_ACK_KIND]: defineMessageSignature(
        RUNTIME_HEARTBEAT_ACK_KIND,
        encodeRuntimeHeartbeatAckEvent,
        decodeRuntimeHeartbeatAckEvent,
    ),
    [RUNTIME_LIVENESS_READY_KIND]: defineMessageSignature(
        RUNTIME_LIVENESS_READY_KIND,
        encodeRuntimeLivenessReadyEvent,
        decodeRuntimeLivenessReadyEvent,
    ),
    "runtime.diagnostics.read": defineMessageSignature(
        "runtime.diagnostics.read",
        encodeRuntimeDiagnosticsRequest,
        decodeRuntimeDiagnosticsRequest,
    ),
    [RUNTIME_PING_KIND]: defineMessageSignature(RUNTIME_PING_KIND, encodeRuntimePingCommand, decodeRuntimePingCommand),
    [SESSION_CANCEL_KIND]: defineMessageSignature(
        SESSION_CANCEL_KIND,
        encodeSessionCancelCommand,
        decodeSessionCancelCommand,
    ),
    [SESSION_CONFIGURE_KIND]: defineMessageSignature(
        SESSION_CONFIGURE_KIND,
        encodeSessionConfigureCommand,
        decodeSessionConfigureCommand,
    ),
    [SESSION_ELICITATION_RESPOND_KIND]: defineMessageSignature(
        SESSION_ELICITATION_RESPOND_KIND,
        encodeSessionElicitationRespondCommand,
        decodeSessionElicitationRespondCommand,
    ),
    [SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND]: defineMessageSignature(
        SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND,
        encodeSessionLiveHistoryV2PageLoad,
        decodeSessionLiveHistoryV2PageLoad,
    ),
    [SESSION_PERMISSION_RESPOND_KIND]: defineMessageSignature(
        SESSION_PERMISSION_RESPOND_KIND,
        encodeSessionPermissionRespondCommand,
        decodeSessionPermissionRespondCommand,
    ),
    [SESSION_PREPARE_KIND]: defineMessageSignature(
        SESSION_PREPARE_KIND,
        encodeSessionPrepareCommand,
        decodeSessionPrepareCommand,
    ),
    [SESSION_PROMPT_KIND]: defineMessageSignature(
        SESSION_PROMPT_KIND,
        encodeSessionPromptCommand,
        decodeSessionPromptCommand,
    ),
    [SESSION_PROMPT_DISPOSITION_KIND]: defineMessageSignature(
        SESSION_PROMPT_DISPOSITION_KIND,
        encodeSessionPromptDispositionCommand,
        decodeSessionPromptDispositionCommand,
    ),
    [WORKSPACE_LIST_KIND]: defineMessageSignature(
        WORKSPACE_LIST_KIND,
        encodeWorkspaceListCommand,
        decodeWorkspaceListCommand,
    ),
} as const;

export type ServiceToDaemonMessage = ReturnType<
    (typeof serviceToDaemonSignatures)[keyof typeof serviceToDaemonSignatures]["decoder"]
>;

const serviceToDaemonRegistry: Readonly<Record<string, MessageSignature<ServiceToDaemonMessage>>> =
    serviceToDaemonSignatures;

export function decodeServiceToDaemonMessage(encoded: string): ServiceToDaemonMessage {
    const kind = decodeMessageKind(encoded);
    const signature = serviceToDaemonRegistry[kind];
    if (signature === undefined) {
        throw new UnsupportedProtocolMessageKindError("service-to-daemon", kind);
    }
    return signature.decoder(encoded);
}

export function encodeServiceToDaemonMessage(message: ServiceToDaemonMessage): string {
    return serviceToDaemonSignatures[message.kind].encoder(message);
}

const daemonToServiceSignatures = {
    [SESSION_CLOSED_KIND]: defineMessageSignature(
        SESSION_CLOSED_KIND,
        encodeSessionClosedEvent,
        decodeSessionClosedEvent,
    ),
    [SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature(
        SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
        encodeSessionPreviewHistoryPageLoaded,
        decodeSessionPreviewHistoryPageLoaded,
    ),
    [SESSION_CONFIG_UPDATED_KIND]: defineMessageSignature(
        SESSION_CONFIG_UPDATED_KIND,
        encodeSessionConfigUpdatedEvent,
        decodeSessionConfigUpdatedEvent,
    ),
    [AGENT_INSTALL_CANCELLED_KIND]: defineMessageSignature(
        AGENT_INSTALL_CANCELLED_KIND,
        encodeAgentInstallCancelledEvent,
        decodeAgentInstallCancelledEvent,
    ),
    [AGENT_INSTALL_COMPLETED_KIND]: defineMessageSignature(
        AGENT_INSTALL_COMPLETED_KIND,
        encodeAgentInstallCompletedEvent,
        decodeAgentInstallCompletedEvent,
    ),
    [AGENT_INSTALL_FAILED_KIND]: defineMessageSignature(
        AGENT_INSTALL_FAILED_KIND,
        encodeAgentInstallFailedEvent,
        decodeAgentInstallFailedEvent,
    ),
    [AGENT_INSTALL_PROGRESS_KIND]: defineMessageSignature(
        AGENT_INSTALL_PROGRESS_KIND,
        encodeAgentInstallProgressEvent,
        decodeAgentInstallProgressEvent,
    ),
    [AGENT_INSTALL_STARTED_KIND]: defineMessageSignature(
        AGENT_INSTALL_STARTED_KIND,
        encodeAgentInstallStartedEvent,
        decodeAgentInstallStartedEvent,
    ),
    [AGENT_SETTINGS_DISCOVERED_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVERED_KIND,
        encodeAgentSettingsDiscoveredEvent,
        decodeAgentSettingsDiscoveredEvent,
    ),
    [AGENT_SETTINGS_DISCOVERY_FAILED_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
        encodeAgentSettingsDiscoveryFailedEvent,
        decodeAgentSettingsDiscoveryFailedEvent,
    ),
    [FILE_BEGIN_KIND]: defineMessageSignature(FILE_BEGIN_KIND, encodeFileBeginEvent, decodeFileBeginEvent),
    [FILE_CHUNK_KIND]: defineMessageSignature(FILE_CHUNK_KIND, encodeFileChunkEvent, decodeFileChunkEvent),
    [FILE_END_KIND]: defineMessageSignature(FILE_END_KIND, encodeFileEndEvent, decodeFileEndEvent),
    [FILE_FAILED_KIND]: defineMessageSignature(FILE_FAILED_KIND, encodeFileFailedEvent, decodeFileFailedEvent),
    [SESSION_LISTED_KIND]: defineMessageSignature(
        SESSION_LISTED_KIND,
        encodeSessionsListedEvent,
        decodeSessionsListedEvent,
    ),
    [SESSION_QUERIED_KIND]: defineMessageSignature(
        SESSION_QUERIED_KIND,
        encodeSessionsQueriedEvent,
        decodeSessionsQueriedEvent,
    ),
    [SESSION_RESTORED_KIND]: defineMessageSignature(
        SESSION_RESTORED_KIND,
        encodeSessionRestoredEvent,
        decodeSessionRestoredEvent,
    ),
    [SESSION_STATUS_CHANGED_KIND]: defineMessageSignature(
        SESSION_STATUS_CHANGED_KIND,
        encodeSessionStatusChangedEvent,
        decodeSessionStatusChangedEvent,
    ),
    [SESSION_INFO_UPDATED_KIND]: defineMessageSignature(
        SESSION_INFO_UPDATED_KIND,
        encodeSessionInfoUpdatedEvent,
        decodeSessionInfoUpdatedEvent,
    ),
    [SESSION_QUEUED_KIND]: defineMessageSignature(
        SESSION_QUEUED_KIND,
        encodeSessionQueuedEvent,
        decodeSessionQueuedEvent,
    ),
    [NATIVE_SESSION_RESULT_KIND]: defineMessageSignature(
        NATIVE_SESSION_RESULT_KIND,
        encodeNativeSessionResult,
        decodeNativeSessionResult,
    ),
    [RUNTIME_HEARTBEAT_KIND]: defineMessageSignature(
        RUNTIME_HEARTBEAT_KIND,
        encodeRuntimeHeartbeatEvent,
        decodeRuntimeHeartbeatEvent,
    ),
    "runtime.upgrade.result": defineMessageSignature(
        "runtime.upgrade.result",
        encodeRuntimeUpgradeResult,
        decodeRuntimeUpgradeResult,
    ),
    "runtime.diagnostics.result": defineMessageSignature(
        "runtime.diagnostics.result",
        encodeRuntimeDiagnosticsResult,
        decodeRuntimeDiagnosticsResult,
    ),
    [RUNTIME_PONG_KIND]: defineMessageSignature(RUNTIME_PONG_KIND, encodeRuntimePongEvent, decodeRuntimePongEvent),
    [SESSION_EVENT_V2_KIND]: defineMessageSignature(
        SESSION_EVENT_V2_KIND,
        encodeSessionEventEnvelopeV2,
        decodeSessionEventEnvelopeV2,
    ),
    [SESSION_OPERATION_FAILED_KIND]: defineMessageSignature(
        SESSION_OPERATION_FAILED_KIND,
        encodeSessionOperationFailedEvent,
        decodeSessionOperationFailedEvent,
    ),
    [SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND]: defineMessageSignature(
        SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
        encodeSessionLiveHistoryV2PageLoaded,
        decodeSessionLiveHistoryV2PageLoaded,
    ),
    [SESSION_READY_KIND]: defineMessageSignature(SESSION_READY_KIND, encodeSessionReadyEvent, decodeSessionReadyEvent),
    [WORKSPACE_ENTRIES_KIND]: defineMessageSignature(
        WORKSPACE_ENTRIES_KIND,
        encodeWorkspaceEntriesEvent,
        decodeWorkspaceEntriesEvent,
    ),
} as const;

export type DaemonToServiceMessage = ReturnType<
    (typeof daemonToServiceSignatures)[keyof typeof daemonToServiceSignatures]["decoder"]
>;

const daemonToServiceRegistry: Readonly<Record<string, MessageSignature<DaemonToServiceMessage>>> =
    daemonToServiceSignatures;

export function decodeDaemonToServiceMessage(encoded: string): DaemonToServiceMessage {
    const kind = decodeMessageKind(encoded);
    const signature = daemonToServiceRegistry[kind];
    if (signature === undefined) {
        throw new UnsupportedProtocolMessageKindError("daemon-to-service", kind);
    }
    return signature.decoder(encoded);
}

export function encodeDaemonToServiceMessage(message: DaemonToServiceMessage): string {
    return daemonToServiceSignatures[message.kind].encoder(message);
}
