import {
    decodeRuntimeDiagnosticsRequest,
    decodeRuntimeDiagnosticsResult,
    encodeRuntimeDiagnosticsRequest,
    encodeRuntimeDiagnosticsResult,
} from "../runtime/diagnostics.ts";
import {
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeRuntimePingCommand,
    decodeRuntimePongEvent,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeHeartbeatEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeRuntimePingCommand,
    encodeRuntimePongEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
} from "../runtime/liveness.ts";
import { decodeRuntimeUpgradeResult, encodeRuntimeUpgradeResult } from "../runtime/upgrade.ts";
import {
    AGENT_CATALOG_DISCOVER_KIND,
    AGENT_CATALOG_DISCOVERED_KIND,
    AGENT_CATALOG_DISCOVERY_FAILED_KIND,
    decodeAgentCatalogDiscoverCommand,
    decodeAgentCatalogDiscoveredEvent,
    decodeAgentCatalogDiscoveryFailedEvent,
    encodeAgentCatalogDiscoverCommand,
    encodeAgentCatalogDiscoveredEvent,
    encodeAgentCatalogDiscoveryFailedEvent,
} from "../session/agent/catalog.ts";
import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    decodeAgentSettingsDiscoverCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeAgentSettingsDiscoveredEvent,
    encodeAgentSettingsDiscoveryFailedEvent,
} from "../session/agent/settings.ts";
import {
    decodeSessionConfigReadCommand,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionConfigureCommand,
    encodeSessionConfigReadCommand,
    encodeSessionConfigReadResult,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
} from "../session/configuration/index.ts";
import {
    decodeSessionRenameCommand,
    decodeSessionRenamedEvent,
    encodeSessionRenameCommand,
    encodeSessionRenamedEvent,
    SESSION_RENAME_KIND,
    SESSION_RENAMED_KIND,
} from "../session/configuration/title.ts";
import {
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeFileReadCommand,
    encodeFileBeginEvent,
    encodeFileChunkEvent,
    encodeFileEndEvent,
    encodeFileFailedEvent,
    encodeFileReadCommand,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
} from "../session/files/index.ts";
import {
    decodeSessionElicitationRespondCommand,
    decodeSessionPermissionRespondCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
} from "../session/interactions/index.ts";
import {
    decodeSessionCloseCommand,
    decodeSessionClosedEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionInfoUpdatedEvent,
    decodeSessionListCommand,
    decodeSessionOperationFailedEvent,
    decodeSessionPrepareCommand,
    decodeSessionQueryCommand,
    decodeSessionReadyEvent,
    decodeSessionRestoreCommand,
    decodeSessionRestoredEvent,
    decodeSessionStatusChangedEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    encodeSessionCloseCommand,
    encodeSessionClosedEvent,
    encodeSessionCloseNoticeEvent,
    encodeSessionInfoUpdatedEvent,
    encodeSessionListCommand,
    encodeSessionOperationFailedEvent,
    encodeSessionPrepareCommand,
    encodeSessionQueryCommand,
    encodeSessionReadyEvent,
    encodeSessionRestoreCommand,
    encodeSessionRestoredEvent,
    encodeSessionStatusChangedEvent,
    encodeSessionsListedEvent,
    encodeSessionsQueriedEvent,
    SESSION_CLOSE_KIND,
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORE_KIND,
    SESSION_RESTORED_KIND,
    SESSION_STATUS_CHANGED_KIND,
} from "../session/lifecycle/index.ts";
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
} from "../session/native/index.ts";
import {
    decodeSessionEventEnvelope,
    encodeSessionEventEnvelope,
    SESSION_EVENT_KIND,
} from "../session/observability/event-log.ts";
import {
    decodeSessionHistoryPageLoad,
    decodeSessionHistoryPageLoaded,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoaded,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
} from "../session/observability/history.ts";
import {
    decodeSessionCancelCommand,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
} from "../session/prompt/commands.ts";
import {
    decodeWorkspaceEntriesEvent,
    decodeWorkspaceListCommand,
    encodeWorkspaceEntriesEvent,
    encodeWorkspaceListCommand,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "../session/workspace/index.ts";
import { decodeMessageKind, UnsupportedProtocolMessageKindError } from "../shared/message-codec.ts";

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
    [AGENT_SETTINGS_DISCOVER_KIND]: defineMessageSignature(
        AGENT_SETTINGS_DISCOVER_KIND,
        encodeAgentSettingsDiscoverCommand,
        decodeAgentSettingsDiscoverCommand,
    ),
    [AGENT_CATALOG_DISCOVER_KIND]: defineMessageSignature(
        AGENT_CATALOG_DISCOVER_KIND,
        encodeAgentCatalogDiscoverCommand,
        decodeAgentCatalogDiscoverCommand,
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
    [SESSION_CONFIG_READ_KIND]: defineMessageSignature(
        SESSION_CONFIG_READ_KIND,
        encodeSessionConfigReadCommand,
        decodeSessionConfigReadCommand,
    ),
    [SESSION_RENAME_KIND]: defineMessageSignature(
        SESSION_RENAME_KIND,
        encodeSessionRenameCommand,
        decodeSessionRenameCommand,
    ),
    [SESSION_ELICITATION_RESPOND_KIND]: defineMessageSignature(
        SESSION_ELICITATION_RESPOND_KIND,
        encodeSessionElicitationRespondCommand,
        decodeSessionElicitationRespondCommand,
    ),
    [SESSION_HISTORY_PAGE_LOAD_KIND]: defineMessageSignature(
        SESSION_HISTORY_PAGE_LOAD_KIND,
        encodeSessionHistoryPageLoad,
        decodeSessionHistoryPageLoad,
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
    [SESSION_CLOSE_NOTICE_KIND]: defineMessageSignature(
        SESSION_CLOSE_NOTICE_KIND,
        encodeSessionCloseNoticeEvent,
        decodeSessionCloseNoticeEvent,
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
    [SESSION_CONFIG_READ_RESULT_KIND]: defineMessageSignature(
        SESSION_CONFIG_READ_RESULT_KIND,
        encodeSessionConfigReadResult,
        decodeSessionConfigReadResult,
    ),
    [SESSION_RENAMED_KIND]: defineMessageSignature(
        SESSION_RENAMED_KIND,
        encodeSessionRenamedEvent,
        decodeSessionRenamedEvent,
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
    [AGENT_CATALOG_DISCOVERED_KIND]: defineMessageSignature(
        AGENT_CATALOG_DISCOVERED_KIND,
        encodeAgentCatalogDiscoveredEvent,
        decodeAgentCatalogDiscoveredEvent,
    ),
    [AGENT_CATALOG_DISCOVERY_FAILED_KIND]: defineMessageSignature(
        AGENT_CATALOG_DISCOVERY_FAILED_KIND,
        encodeAgentCatalogDiscoveryFailedEvent,
        decodeAgentCatalogDiscoveryFailedEvent,
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
    [SESSION_EVENT_KIND]: defineMessageSignature(
        SESSION_EVENT_KIND,
        encodeSessionEventEnvelope,
        decodeSessionEventEnvelope,
    ),
    [SESSION_OPERATION_FAILED_KIND]: defineMessageSignature(
        SESSION_OPERATION_FAILED_KIND,
        encodeSessionOperationFailedEvent,
        decodeSessionOperationFailedEvent,
    ),
    [SESSION_HISTORY_PAGE_LOADED_KIND]: defineMessageSignature(
        SESSION_HISTORY_PAGE_LOADED_KIND,
        encodeSessionHistoryPageLoaded,
        decodeSessionHistoryPageLoaded,
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
