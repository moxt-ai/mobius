import {
    decodeMessageKind,
    decodeRuntimeDelivery,
    decodeRuntimeDeliveryCommitted,
    decodeRuntimeDeliveryReceived,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeSessionCancelCommand,
    decodeSessionPromptCommand,
    encodeRuntimeDelivery,
    encodeRuntimeDeliveryCommitted,
    encodeRuntimeDeliveryReceived,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeHeartbeatEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    ProtocolMessageError,
} from "./codecs/messages.ts";
import {
    AGENT_CATALOG_REFRESH_FAILED_KIND,
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
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
    decodeAgentCatalogRefreshCommand,
    decodeAgentCatalogRefreshedEvent,
    decodeAgentCatalogRefreshFailedEvent,
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
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    decodeWorkspaceListCommand,
    encodeAgentCatalogRefreshCommand,
    encodeAgentCatalogRefreshedEvent,
    encodeAgentCatalogRefreshFailedEvent,
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
    encodeSessionConfigureCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionOperationFailedEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionReadyEvent,
    encodeWorkspaceEntriesEvent,
    encodeWorkspaceListCommand,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_READY_KIND,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "./control-messages.ts";
import {
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_KIND,
} from "./messages.ts";
import {
    decodeNativeSessionCancel,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    decodeNativeSessionTurnForkCommand,
    encodeNativeSessionCancel,
    encodeNativeSessionCommand,
    encodeNativeSessionResult,
    encodeNativeSessionTurnForkCommand,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    NATIVE_SESSION_TURN_FORK_KIND,
} from "./native-sessions.ts";
import {
    decodeSessionEventAcknowledgement,
    decodeSessionEventDeferred,
    decodeSessionEventEnvelope,
    decodeSessionEventRejection,
    encodeSessionEventAcknowledgement,
    encodeSessionEventDeferred,
    encodeSessionEventEnvelope,
    encodeSessionEventRejection,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
} from "./session-events.ts";

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
    [AGENT_CATALOG_REFRESH_KIND]: defineMessageSignature(
        AGENT_CATALOG_REFRESH_KIND,
        encodeAgentCatalogRefreshCommand,
        decodeAgentCatalogRefreshCommand,
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
    [NATIVE_SESSION_TURN_FORK_KIND]: defineMessageSignature(
        NATIVE_SESSION_TURN_FORK_KIND,
        encodeNativeSessionTurnForkCommand,
        decodeNativeSessionTurnForkCommand,
    ),
    [RUNTIME_DELIVERY_KIND]: defineMessageSignature(
        RUNTIME_DELIVERY_KIND,
        encodeRuntimeDelivery,
        decodeRuntimeDelivery,
    ),
    [RUNTIME_DELIVERY_COMMITTED_KIND]: defineMessageSignature(
        RUNTIME_DELIVERY_COMMITTED_KIND,
        encodeRuntimeDeliveryCommitted,
        decodeRuntimeDeliveryCommitted,
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
    [SESSION_EVENT_ACK_KIND]: defineMessageSignature(
        SESSION_EVENT_ACK_KIND,
        encodeSessionEventAcknowledgement,
        decodeSessionEventAcknowledgement,
    ),
    [SESSION_EVENT_DEFERRED_KIND]: defineMessageSignature(
        SESSION_EVENT_DEFERRED_KIND,
        encodeSessionEventDeferred,
        decodeSessionEventDeferred,
    ),
    [SESSION_EVENT_REJECTED_KIND]: defineMessageSignature(
        SESSION_EVENT_REJECTED_KIND,
        encodeSessionEventRejection,
        decodeSessionEventRejection,
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
        throw new ProtocolMessageError(`Unsupported service-to-daemon message kind: ${kind}`);
    }
    return signature.decoder(encoded);
}

export function encodeServiceToDaemonMessage(message: ServiceToDaemonMessage): string {
    return serviceToDaemonSignatures[message.kind].encoder(message);
}

const daemonToServiceSignatures = {
    [AGENT_CATALOG_REFRESHED_KIND]: defineMessageSignature(
        AGENT_CATALOG_REFRESHED_KIND,
        encodeAgentCatalogRefreshedEvent,
        decodeAgentCatalogRefreshedEvent,
    ),
    [AGENT_CATALOG_REFRESH_FAILED_KIND]: defineMessageSignature(
        AGENT_CATALOG_REFRESH_FAILED_KIND,
        encodeAgentCatalogRefreshFailedEvent,
        decodeAgentCatalogRefreshFailedEvent,
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
    [NATIVE_SESSION_RESULT_KIND]: defineMessageSignature(
        NATIVE_SESSION_RESULT_KIND,
        encodeNativeSessionResult,
        decodeNativeSessionResult,
    ),
    [RUNTIME_DELIVERY_RECEIVED_KIND]: defineMessageSignature(
        RUNTIME_DELIVERY_RECEIVED_KIND,
        encodeRuntimeDeliveryReceived,
        decodeRuntimeDeliveryReceived,
    ),
    [RUNTIME_HEARTBEAT_KIND]: defineMessageSignature(
        RUNTIME_HEARTBEAT_KIND,
        encodeRuntimeHeartbeatEvent,
        decodeRuntimeHeartbeatEvent,
    ),
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
        throw new ProtocolMessageError(`Unsupported daemon-to-service message kind: ${kind}`);
    }
    return signature.decoder(encoded);
}

export function encodeDaemonToServiceMessage(message: DaemonToServiceMessage): string {
    return daemonToServiceSignatures[message.kind].encoder(message);
}
