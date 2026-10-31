import {
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
    type LifecycleMetadata,
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
