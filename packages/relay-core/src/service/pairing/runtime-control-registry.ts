import {
    AGENT_CATALOG_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_WRITE_KIND,
    decodeNativeSessionResult,
    decodeRuntimeDiagnosticsResult,
    decodeRuntimePongEvent,
    decodeSessionClosedEvent,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionHistoryWirePageLoaded,
    decodeSessionPermissionResolvedEvent,
    decodeSessionPreviewHistoryWirePageLoaded,
    decodeSessionPromptAcceptedEvent,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    FILE_READ_KIND,
    type LifecycleMetadata,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_PING_KIND,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_LIST_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERY_KIND,
    SESSION_RENAME_KIND,
    SESSION_RESTORE_KIND,
    type ServiceToDaemonMessage,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "./runtime-control-request.ts";

type DirectResult = Extract<RuntimeControlResult, { readonly requestId: string } | { readonly interactionId: string }>;

interface DirectReply {
    readonly kind: "direct";
    readonly eventKind: DirectResult["kind"];
    readonly decode: (data: string) => DirectResult;
}

type RuntimeControlReply =
    | DirectReply
    | {
          readonly kind: "lifecycle";
          readonly resolveOn: readonly LifecycleMetadata["kind"][];
          readonly direct: DirectReply | null;
      };

interface RuntimeControlDefinition {
    readonly permission: ProjectPermission | ((command: RuntimeControlCommand) => ProjectPermission);
    readonly reply: RuntimeControlReply;
}

function directReply<K extends DirectResult["kind"]>(
    eventKind: K,
    decode: (data: string) => Extract<DirectResult, { readonly kind: NoInfer<K> }>,
) {
    return { kind: "direct", eventKind, decode } satisfies RuntimeControlReply;
}

function lifecycleReply(
    resolveOn: readonly LifecycleMetadata["kind"][],
    direct: DirectReply | null = null,
): Extract<RuntimeControlReply, { readonly kind: "lifecycle" }> {
    return { kind: "lifecycle", resolveOn, direct };
}

/** Code-owned command policy; callers must still authorize the selected permission. */
export const runtimeControlRegistry = {
    "runtime.diagnostics.read": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("runtime.diagnostics.result", decodeRuntimeDiagnosticsResult),
    },
    "runtime.ping": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("runtime.pong", decodeRuntimePongEvent),
    },
    "native.session.request": {
        permission: (command: RuntimeControlCommand) =>
            command.kind === "native.session.request" && command.action === "list"
                ? ProjectPermission.RuntimeRead
                : ProjectPermission.SessionWrite,
        reply: directReply("native.session.result", decodeNativeSessionResult),
    },
    "session.prepare": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.ready", decodeSessionReadyEvent),
    },
    "session.configure": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.config.updated", decodeSessionConfigUpdatedEvent),
    },
    "session.config.read": {
        permission: ProjectPermission.RuntimeRead,
        reply: directReply("session.config.read.result", decodeSessionConfigReadResult),
    },
    "session.rename": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.renamed", decodeSessionRenamedEvent),
    },
    "session.close": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.closed", decodeSessionClosedEvent),
    },
    "session.cancel-before-start": {
        permission: ProjectPermission.SessionWrite,
        reply: lifecycleReply(["prompt.completed"]),
    },
    "session.cancel": {
        permission: ProjectPermission.SessionWrite,
        reply: lifecycleReply(["prompt.completed"]),
    },
    "session.prompt.disposition": {
        permission: ProjectPermission.SessionWrite,
        reply: lifecycleReply(["prompt.started"]),
    },
    "session.prompt": {
        permission: ProjectPermission.SessionWrite,
        // A first submission is answered by its own lifecycle events; a retried command records none, so the
        // Runtime answers it directly.
        reply: lifecycleReply(
            ["prompt.started"],
            directReply("session.prompt.accepted", decodeSessionPromptAcceptedEvent),
        ),
    },
    "session.preview-history.page.load": {
        permission: ProjectPermission.RuntimeRead,
        reply: directReply("session.preview-history.page.loaded", decodeSessionPreviewHistoryWirePageLoaded),
    },
    "session.live-history.v2.page.load": {
        permission: ProjectPermission.SessionRead,
        reply: directReply("session.live-history.v2.page.loaded", decodeSessionHistoryWirePageLoaded),
    },
    "session.elicitation.respond": {
        permission: ProjectPermission.SessionWrite,
        reply: lifecycleReply(
            ["session.elicitation.resolved"],
            directReply("session.elicitation.resolved", decodeSessionElicitationResolvedEvent),
        ),
    },
    "session.permission.respond": {
        permission: ProjectPermission.SessionWrite,
        reply: lifecycleReply(
            ["session.permission.resolved"],
            directReply("session.permission.resolved", decodeSessionPermissionResolvedEvent),
        ),
    },
    "session.list": {
        permission: ProjectPermission.RuntimeRead,
        reply: directReply("session.listed", decodeSessionsListedEvent),
    },
    "session.query": {
        permission: ProjectPermission.RuntimeRead,
        reply: directReply("session.queried", decodeSessionsQueriedEvent),
    },
    "session.restore": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.restored", decodeSessionRestoredEvent),
    },
} satisfies { readonly [K in RuntimeControlCommand["kind"]]: RuntimeControlDefinition };

export function runtimeControlPermission(command: RuntimeControlCommand): ProjectPermission {
    const { permission } = runtimeControlRegistry[command.kind];
    return typeof permission === "function" ? permission(command) : permission;
}

/**
 * What a credential must grant to send this message to a Runtime, however it reaches the Relay: an HTTP route and a
 * host connection apply the same answer. Null for messages only the Relay itself sends to a daemon.
 */
export function runtimeCommandPermission(message: ServiceToDaemonMessage): ProjectPermission | null {
    switch (message.kind) {
        case "runtime.diagnostics.read":
        case RUNTIME_PING_KIND:
        case NATIVE_SESSION_REQUEST_KIND:
        case SESSION_PREPARE_KIND:
        case SESSION_CONFIGURE_KIND:
        case SESSION_CONFIG_READ_KIND:
        case SESSION_RENAME_KIND:
        case SESSION_CLOSE_KIND:
        case SESSION_CANCEL_BEFORE_START_KIND:
        case SESSION_CANCEL_KIND:
        case SESSION_PROMPT_DISPOSITION_KIND:
        case SESSION_PROMPT_KIND:
        case SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND:
        case SESSION_HISTORY_PAGE_LOAD_KIND:
        case SESSION_ELICITATION_RESPOND_KIND:
        case SESSION_PERMISSION_RESPOND_KIND:
        case SESSION_LIST_KIND:
        case SESSION_QUERY_KIND:
        case SESSION_RESTORE_KIND:
            return runtimeControlPermission(message);
        case AGENT_CATALOG_DISCOVER_KIND:
        case AGENT_SETTINGS_DISCOVER_KIND:
        case WORKSPACE_LIST_KIND:
            return ProjectPermission.RuntimeRead;
        case FILE_READ_KIND:
            return ProjectPermission.SessionRead;
        case CONTENT_WRITE_KIND:
        case CONTENT_COMMIT_KIND:
        case NATIVE_SESSION_CANCEL_KIND:
            return ProjectPermission.SessionWrite;
        case RUNTIME_HEARTBEAT_ACK_KIND:
        case RUNTIME_LIVENESS_READY_KIND:
            return null;
        default:
            return message satisfies never;
    }
}
