import type { LocalSessionOperations, SessionRuntimeOperations } from "@moxt-ai/mobius-relay-core";
import {
    acceptWebSocketHttpTransport,
    CloudflareChannelRuntime,
    createMobiusApplication,
    createWorkerContext,
    errorMiddleware,
    instrumentD1Database,
    PairingDirectoryError,
    ProjectPermission,
    ProjectScope,
    type RelayContext,
    RequestAccessMetrics,
    requestTimeoutMiddleware,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import type { SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionRequest,
    decodeRuntimeStatusEvent,
    decodeSessionCancelCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueryCommand,
    decodeSessionRenameCommand,
    decodeSessionWireEnvelope,
    type Identifier,
    isDirectoryIdentifier,
    isIdentifier,
    MOBIUS_API_PREFIX,
    ProtocolMessageError,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { type Context, type Handler, Hono } from "hono";
import * as v from "valibot";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./composition/platform-authentication-environment.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import type { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
import {
    type ProjectDurableObjectExecutionBindings,
    type ProjectWorkerRoutingBindings,
    routeProjectDurableObject,
} from "./gateway/project-durable-object-routing.ts";
import { routeRuntimeSessionRequest } from "./gateway/runtime-session-routing.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import {
    recordingReadRoutes,
    recordingSessionStatusRoutes,
    recordingSummaryV2Routes,
} from "./http/recording-read-routes.ts";
import { ClerkOrganizationGateway } from "./infra/clerk-organization-gateway.ts";
import type { OrganizationMembershipGateway } from "./infra/organization-membership-gateway.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { createBrowserCors } from "./middleware/browser-cors.ts";
import {
    initializeSessionAccessTargetMiddleware,
    sessionAccessTargetMiddleware,
} from "./middleware/session-access-target.ts";
import { AppCredentialAuthenticationService } from "./service/app-credential-authentication-service.ts";
import { AppSessionStatusWebhookService } from "./service/app-session-status-webhook-service.ts";
import { OrganizationAdministrators } from "./service/organization-administrators.ts";
import { OrganizationInviteService } from "./service/organization-invite-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import { RecordingPolicyService } from "./service/recording-policy-service.ts";
import { SessionAccessService, type SessionAccessTarget } from "./service/session-access-service.ts";
import { AppSessionStatusWebhookStorage } from "./storage/app-session-status-webhook-storage.ts";
import { OrganizationInviteStorage } from "./storage/organization-invite-storage.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "./storage/platform-database-resolver.ts";
import { RecordingPolicyStorage } from "./storage/recording-policy-storage.ts";

export interface PlatformRelayBindings extends PlatformStorageBindings, ProjectWorkerRoutingBindings {
    readonly CLERK_SECRET_KEY?: string;
    readonly MOBIUS_SESSION_EVENT_PUSH_SECRET?: string;
    readonly MOBIUS_SESSION_STATUS_WEBHOOK_URL?: string;
    readonly MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY?: string;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
    readonly RUNTIME_RELAY: DurableObjectNamespace<RuntimeRelay>;
}

export interface ProjectPlatformRelayBindings extends PlatformRelayBindings, ProjectDurableObjectExecutionBindings {}

export interface RuntimeExecutionBindings extends PlatformRelayBindings {
    readonly MOBIUS_RUNTIME_EXECUTION: {
        readonly projectId: string;
        readonly runtimeId: string;
        readonly operations: LocalSessionOperations;
    };
}
type PlatformApplicationBindings = PlatformRelayBindings | ProjectPlatformRelayBindings | RuntimeExecutionBindings;

export interface ConfiguredPlatformRelayBindings extends PlatformRelayBindings, PlatformAuthenticationEnvironment {}

function sessionOperations(context: {
    readonly env: PlatformApplicationBindings;
    readonly var: { readonly relay: RelayContext };
}) {
    return "MOBIUS_RUNTIME_EXECUTION" in context.env
        ? context.env.MOBIUS_RUNTIME_EXECUTION.operations
        : context.var.relay.services.runtimePairings;
}

const projectApplication = createMobiusApplication();
const scopedProjectApplication = createProjectApplication();
const controlApplication = createPlatformControlApplication();
const PLATFORM_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const sessionIdentifier = v.custom<Identifier>(isIdentifier);
const sessionPromptBody = v.strictObject({
    additionalDirectoryIds: v.pipe(v.array(v.string()), v.maxLength(16)),
    agentId: v.optional(sessionIdentifier),
    attachments: v.pipe(v.array(v.unknown()), v.maxLength(16)),
    content: v.pipe(v.string(), v.maxLength(100000)),
    disposition: v.optional(v.picklist(["reject", "queue", "steer"]), "reject"),
    directoryId: v.optional(v.custom<string>(isDirectoryIdentifier)),
    idempotencyKey: sessionIdentifier,
    sessionConfigurations: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(100)), []),
    targetCommandId: v.optional(v.string(), ""),
});
const sessionPromptDispositionBody = v.strictObject({ disposition: v.literal("steer") });
const sessionConfigurationBody = v.strictObject({
    additionalDirectoryIds: v.pipe(v.array(v.custom<string>(isDirectoryIdentifier)), v.maxLength(16)),
    agentId: sessionIdentifier,
    booleanValue: v.boolean(),
    configId: sessionIdentifier,
    expectedConfigurationRevision: v.optional(sessionIdentifier),
    directoryId: v.custom<string>(isDirectoryIdentifier),
    value: v.pipe(v.string(), v.maxLength(500)),
    valueType: v.picklist(["select", "boolean"]),
});
const sessionRenameBody = v.strictObject({
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
});
const sessionInteractionResponseBody = v.variant("kind", [
    v.strictObject({
        kind: v.literal("permission"),
        optionId: v.pipe(v.string(), v.maxLength(255)),
        outcome: v.picklist(["cancelled", "selected"]),
        responderId: sessionIdentifier,
    }),
    v.strictObject({
        action: v.picklist(["accept", "cancel", "decline"]),
        content: v.pipe(v.string(), v.maxLength(100000)),
        kind: v.literal("elicitation"),
        responderId: sessionIdentifier,
    }),
]);

type DispatchEnvironment = {
    readonly Bindings: PlatformApplicationBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
        readonly databases: PlatformDatabaseResolver;
        readonly storageRegistry: PlatformStorageRegistry;
        readonly projectDatabases: SqlDatabase[];
        readonly relay: RelayContext;
        readonly recordingPolicies: RecordingPolicyService;
        readonly appSessionStatusWebhooks: AppSessionStatusWebhookService;
        readonly sessionAccess: SessionAccessService;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
};

function optionalExecutionContext(context: Pick<Context, "executionCtx">): Context["executionCtx"] | undefined {
    try {
        return context.executionCtx;
    } catch {
        return undefined;
    }
}

async function runtimeSessionIdentity(
    relay: SessionRuntimeOperations,
    target: { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string },
    signal: AbortSignal,
) {
    const queried = await relay.requestProjectScopeControl(
        new ProjectScope(target.projectId),
        target.runtimeId,
        decodeSessionQueryCommand(
            JSON.stringify({ kind: "session.query", requestId: crypto.randomUUID(), sessionIds: [target.sessionId] }),
        ),
        signal,
    );
    if (queried.kind !== "session.queried") {
        throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Session query");
    }
    const session = queried.entries.find((entry) => entry.sessionId === target.sessionId);
    if (session === undefined) {
        throw new PairingDirectoryError("session_not_found", "The selected Session is unavailable");
    }
    return session;
}

export function createPlatformApplication(
    authentication: PlatformAuthenticationConfiguration,
    gateways: (environment: PlatformApplicationBindings) => WorkerRuntimeGateways,
    organizations: (environment: PlatformRelayBindings) => OrganizationMembershipGateway = (environment) =>
        new ClerkOrganizationGateway(environment.CLERK_SECRET_KEY),
): Hono<{ Bindings: PlatformApplicationBindings }> {
    const controlHandler: Handler<DispatchEnvironment> = (context) =>
        controlApplication.fetch(context.req.raw, {
            control: context.var.control,
            appAuthentication: context.var.appAuthentication,
            allowedOrigins: authentication.allowedOrigins,
            invites: new OrganizationInviteService(
                new OrganizationInviteStorage(context.env.PLATFORM_DIRECTORY_DATABASE),
                organizations(context.env),
                new OrganizationAdministrators(organizations(context.env)),
            ),
            recordingPolicies: context.var.recordingPolicies,
            appSessionStatusWebhooks: context.var.appSessionStatusWebhooks,
        });
    const projectHandler: Handler<DispatchEnvironment> = (context) =>
        scopedProjectApplication.fetch(context.req.raw, {
            relay: context.var.relay,
            allowedOrigins: authentication.allowedOrigins,
        });

    const controlRoutes = new Hono<DispatchEnvironment>()
        .all("/health", controlHandler)
        .all("/capabilities", controlHandler)
        .route(
            "/v1",
            new Hono<DispatchEnvironment>()
                .all("/apps/*", controlHandler)
                .all("/platform/*", controlHandler)
                .route(
                    "/projects/:projectId",
                    new Hono<DispatchEnvironment>()
                        .all("/storage-placement", controlHandler)
                        .all("/storage-placement/", controlHandler)
                        .all("/audit-events", controlHandler)
                        .all("/audit-events/", controlHandler)
                        .all("/recording-policy", controlHandler)
                        .all("/recording-policy/", controlHandler)
                        .all("/sessions/*", controlHandler),
                ),
        );
    const sessionRoutes = new Hono<DispatchEnvironment>()
        .use(
            "*",
            createBrowserCors(
                ["GET", "POST", "PUT"],
                [
                    "authorization",
                    "content-type",
                    "x-mobius-byte-length",
                    "x-mobius-content-kind",
                    "x-mobius-file-name",
                    "x-mobius-oidc-provider",
                ],
                authentication.allowedOrigins,
            ),
        )
        .post("/:sessionId/access-credentials", sessionAccessTargetMiddleware, async (context) => {
            const authorization = context.req.header("authorization") ?? "";
            const credential = authorization.match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "project_credential_required", message: "An App credential is required" } },
                    401,
                );
            }
            const body: unknown = await context.req.json();
            const input = v.parse(
                v.strictObject({
                    expiresInSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(60), v.maxValue(900)),
                    runtimeId: sessionIdentifier,
                }),
                body,
            );
            const access = await context.var.sessionAccess.issue(
                context.var.sessionAccessTarget,
                input.runtimeId,
                credential,
                input.expiresInSeconds,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(access, 201);
        })
        .get("/:sessionId/live-event-subscription-target", sessionAccessTargetMiddleware, async (context) => {
            const authorization = context.req.header("authorization") ?? "";
            const credential = authorization.match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    {
                        error: {
                            code: "session_access_required",
                            message: "A live Session credential is required",
                        },
                    },
                    401,
                );
            }
            const target = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ ...target, kind: "expiring" });
        })
        .get("/:sessionId/native-events-preview", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionRead,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            if (context.req.queries("omit") !== undefined) {
                v.parse(v.pipe(v.array(v.literal("agent-reasoning")), v.maxLength(1)), context.req.queries("omit"));
            }
            const eventLimit = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                Number(context.req.query("eventLimit") ?? "50"),
            );
            const result = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionPreviewHistoryPageLoad(
                    JSON.stringify({
                        additionalDirectoryIds: v.parse(
                            v.pipe(v.array(v.custom<string>(isDirectoryIdentifier)), v.maxLength(16)),
                            context.req.queries("additionalDirectoryId") ?? [],
                        ),
                        agentId: v.parse(sessionIdentifier, context.req.query("agentId")),
                        bindingId: "workspace",
                        cursor: context.req.query("cursor") ?? null,
                        directoryId: v.parse(v.custom<string>(isDirectoryIdentifier), context.req.query("directoryId")),
                        kind: "session.preview-history.page.load",
                        eventLimit,
                        requestId: crypto.randomUUID(),
                        sessionId,
                    }),
                ),
                context.req.raw.signal,
            );
            if (result.kind !== "session.preview-history.page.loaded") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
            }
            context.header("Cache-Control", "no-store");
            return context.json(result.events);
        })
        .get("/:sessionId/configuration", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionRead,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const result = await context.var.relay.services.runtimePairings.requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionConfigReadCommand(
                    JSON.stringify({
                        kind: "session.config.read",
                        requestId: crypto.randomUUID(),
                        sessionId,
                    }),
                ),
                context.req.raw.signal,
            );
            if (result.kind !== "session.config.read.result") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid Session settings");
            }
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .get("/:sessionId/active-turn", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const additionalDirectoryIds = v.parse(
                v.pipe(v.array(v.custom<string>(isDirectoryIdentifier)), v.maxLength(16)),
                context.req.queries("additionalDirectoryId") ?? [],
            );
            const agentId = v.parse(sessionIdentifier, context.req.query("agentId"));
            const directoryId = v.parse(v.custom<string>(isDirectoryIdentifier), context.req.query("directoryId"));
            const commandId = context.req.query("commandId");
            const result = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeNativeSessionRequest(
                    JSON.stringify({
                        action: "active-turn",
                        additionalDirectoryIds,
                        agentId,
                        bindingId: "workspace",
                        ...(commandId === undefined
                            ? {}
                            : { deliveryCommandId: v.parse(sessionIdentifier, commandId) }),
                        directoryId,
                        kind: "native.session.request",
                        requestId: crypto.randomUUID(),
                        sessionId,
                        targetSessionId: sessionId,
                    }),
                ),
                context.req.raw.signal,
            );
            if (result.kind !== "native.session.result" || result.action !== "active-turn") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid active Turn");
            }
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/turns", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const parsed = v.safeParse(sessionPromptBody, await context.req.json());
            if (!parsed.success) {
                throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", {
                    cause: new v.ValiError(parsed.issues),
                });
            }
            const body = parsed.output;
            const identity =
                body.agentId === undefined || body.directoryId === undefined
                    ? await runtimeSessionIdentity(
                          sessionOperations(context),
                          { projectId: access.projectId, runtimeId: access.runtimeId, sessionId },
                          context.req.raw.signal,
                      )
                    : { agentId: body.agentId, directoryId: body.directoryId };
            let command: SessionPromptCommand;
            try {
                command = decodeSessionPromptCommand(
                    JSON.stringify({
                        additionalDirectoryIds: body.additionalDirectoryIds,
                        agentId: identity.agentId,
                        bindingId: "workspace",
                        commandId: body.idempotencyKey,
                        directoryId: identity.directoryId,
                        disposition: body.disposition,
                        attachments: body.attachments,
                        kind: "session.prompt",
                        prompt: body.content,
                        sessionConfigurations: body.sessionConfigurations,
                        sessionId,
                        targetCommandId: body.targetCommandId,
                    }),
                );
            } catch (error) {
                // The caller supplied this prompt, so protocol rejection is a client error, not a retryable outage.
                if (error instanceof ProtocolMessageError) {
                    throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", { cause: error });
                }
                throw error;
            }
            const accepted = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                command,
                context.req.raw.signal,
            );
            if (accepted.kind !== "turn.started" && accepted.kind !== "turn.queued") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Turn");
            }
            const acceptedAt = new Date().toISOString();
            context.header("Cache-Control", "no-store");
            return context.json({
                acceptedAt,
                bindingId: "workspace",
                idempotencyKey: body.idempotencyKey,
                request: {
                    content: body.content,
                    kind: "prompt",
                    sessionConfigurations: body.sessionConfigurations,
                },
                sessionId,
                state:
                    accepted.kind === "turn.queued"
                        ? { kind: "queued" as const }
                        : { kind: "running" as const, startedAt: acceptedAt },
                turnId: accepted.commandId,
            });
        })
        .put("/:sessionId/turns/:turnId/disposition", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
            const body = v.parse(sessionPromptDispositionBody, await context.req.json());
            const started = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionPromptDispositionCommand(
                    JSON.stringify({
                        commandId: turnId,
                        disposition: body.disposition,
                        kind: "session.prompt.disposition",
                        sessionId,
                    }),
                ),
                context.req.raw.signal,
            );
            if (started.kind !== "turn.started" || started.commandId !== turnId) {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid steered Turn");
            }
            context.header("Cache-Control", "no-store");
            return context.json({ turnId });
        })
        .get("/:sessionId/files/content", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const path = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), context.req.query("path"));
            const maxBytes = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(128 * 1024 * 1024)),
                Number(context.req.query("maxBytes") ?? String(32 * 1024 * 1024)),
            );
            return await sessionOperations(context).readProjectSessionFile(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeFileReadCommand(
                    JSON.stringify({ kind: "file.read", maxBytes, path, requestId: crypto.randomUUID(), sessionId }),
                ),
                context.req.raw.signal,
            );
        })
        .put("/:sessionId/content/:contentKey", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const contentKey = v.parse(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)), context.req.param("contentKey"));
            const byteLength = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(CONTENT_WRITE_MAX_BYTES)),
                Number(context.req.header("x-mobius-byte-length") ?? ""),
            );
            const contentKind = v.parse(v.picklist(["image", "resource"]), context.req.header("x-mobius-content-kind"));
            const mediaType = v.parse(
                v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
                context.req.header("content-type"),
            );
            const encodedName = v.parse(
                v.pipe(v.string(), v.minLength(1), v.maxLength(1_500)),
                context.req.header("x-mobius-file-name"),
            );
            const uri = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)), context.req.query("uri"));
            const body = context.req.raw.body;
            if (body === null) {
                throw new PairingDirectoryError("invalid_request", "The content body is required");
            }
            let name: string;
            try {
                name = decodeURIComponent(encodedName);
            } catch (cause) {
                throw new PairingDirectoryError("invalid_request", "The content name is invalid", { cause });
            }
            name = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), name);
            const available = await sessionOperations(context).writeProjectSessionContent(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeContentWriteCommand(
                    JSON.stringify({
                        byteLength,
                        contentKey,
                        contentKind,
                        kind: "content.write",
                        mediaType,
                        name,
                        requestId: crypto.randomUUID(),
                        sessionId,
                    }),
                ),
                body,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({
                byteLength,
                contentKey: available.contentKey,
                kind: contentKind,
                mimeType: mediaType,
                name,
                uri,
            });
        })
        .post("/:sessionId/configuration", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const body = v.parse(sessionConfigurationBody, await context.req.json());
            const result = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionConfigureCommand(
                    JSON.stringify({
                        ...body,
                        additionalDirectoryIds: body.additionalDirectoryIds,
                        agentId: body.agentId,
                        bindingId: "workspace",
                        directoryId: body.directoryId,
                        kind: "session.configure",
                        requestId: crypto.randomUUID(),
                        sessionId,
                    }),
                ),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/rename", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const body = v.parse(sessionRenameBody, await context.req.json());
            const result = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionRenameCommand(
                    JSON.stringify({
                        kind: "session.rename",
                        requestId: crypto.randomUUID(),
                        sessionId,
                        title: body.title,
                    }),
                ),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/turns/:turnId/cancel", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
            const body = v.parse(v.strictObject({ idempotencyKey: sessionIdentifier }), await context.req.json());
            const completed = await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                decodeSessionCancelCommand(JSON.stringify({ commandId: turnId, kind: "session.cancel", sessionId })),
                context.req.raw.signal,
            );
            if (completed.kind !== "turn.completed") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
            }
            const cancelledAt = new Date().toISOString();
            context.header("Cache-Control", "no-store");
            return context.json({
                acceptedAt: cancelledAt,
                bindingId: "workspace",
                idempotencyKey: body.idempotencyKey,
                request: { content: "", kind: "prompt", sessionConfigurations: [] },
                sessionId,
                state: { cancelledAt, kind: "cancelled" },
                turnId,
            });
        })
        .post("/:sessionId/interactions/:interactionId/responses", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeSession(
                context.var.sessionAccessTarget,
                credential,
                ProjectPermission.SessionWrite,
                context.req.raw.signal,
            );
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const interactionId = v.parse(sessionIdentifier, context.req.param("interactionId"));
            const body = v.parse(sessionInteractionResponseBody, await context.req.json());
            const command =
                body.kind === "permission"
                    ? decodeSessionPermissionRespondCommand(
                          JSON.stringify({
                              interactionId,
                              kind: "session.permission.respond",
                              optionId: body.optionId,
                              outcome: body.outcome,
                              sessionId,
                          }),
                      )
                    : decodeSessionElicitationRespondCommand(
                          JSON.stringify({
                              action: body.action,
                              content: body.content,
                              interactionId,
                              kind: "session.elicitation.respond",
                              sessionId,
                          }),
                      );
            await sessionOperations(context).requestProjectScopeControl(
                new ProjectScope(access.projectId),
                access.runtimeId,
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ accepted: true });
        })
        .get("/:sessionId/events-v2", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const target = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
                if (context.req.queries("omit") !== undefined) {
                    v.parse(v.pipe(v.array(v.literal("agent-reasoning")), v.maxLength(1)), context.req.queries("omit"));
                }
                const result = await sessionOperations(context).requestProjectScopeControl(
                    new ProjectScope(target.projectId),
                    target.runtimeId,
                    decodeSessionHistoryPageLoad(
                        JSON.stringify({
                            cursor: context.req.query("cursor") ?? null,
                            eventLimit: v.parse(
                                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                                Number(context.req.query("limit") ?? "50"),
                            ),
                            kind: "session.live-history.v2.page.load",
                            requestId: crypto.randomUUID(),
                            sessionId: context.req.param("sessionId"),
                        }),
                    ),
                    context.req.raw.signal,
                );
                if (result.kind !== "session.live-history.v2.page.loaded") {
                    throw new PairingDirectoryError(
                        "invalid_request",
                        "The Runtime returned invalid V2 Session events",
                    );
                }
                context.header("Cache-Control", "no-store");
                return context.json(result.events.events);
            }
            if ("MOBIUS_RUNTIME_EXECUTION" in context.env) {
                return await context.env.MOBIUS_RUNTIME_EXECUTION.operations.openPublicSessionEvents(
                    new ProjectScope(target.projectId),
                    target.runtimeId,
                    context.req.param("sessionId"),
                    target.expiresAtEpochMilliseconds,
                    context.req.raw.signal,
                );
            }
            const host = await sessionOperations(context).openProjectSessionEventHost(
                new ProjectScope(target.projectId),
                target.runtimeId,
                context.req.param("sessionId"),
                context.req.raw.signal,
            );
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            let closed = false;
            const expirationTimeout = setTimeout(
                () => close(),
                Math.max(0, target.expiresAtEpochMilliseconds - Date.now()),
            );
            const close = (): void => {
                if (closed) {
                    return;
                }
                closed = true;
                clearTimeout(expirationTimeout);
                server.close(1000, "V2 Session event subscription closed");
                void host.close();
            };
            server.accept();
            host.socket.addEventListener("message", (event) => {
                if (closed || typeof event.data !== "string") {
                    return;
                }
                try {
                    const kind = decodeMessageKind(event.data);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(event.data).online) {
                            close();
                        }
                        return;
                    }
                    if (kind === "session.event.v2") {
                        const envelope = decodeSessionWireEnvelope(event.data);
                        const events = envelope.events.filter(
                            (sessionEvent) => sessionEvent.sessionId === context.req.param("sessionId"),
                        );
                        if (events.length > 0) {
                            server.send(JSON.stringify(events));
                        }
                    }
                } catch {
                    server.close(1007, "Invalid Runtime event");
                    void host.close();
                }
            });
            host.socket.addEventListener("close", close, { once: true });
            host.socket.addEventListener("error", close, { once: true });
            server.addEventListener("close", close, { once: true });
            server.addEventListener("error", close, { once: true });
            host.socket.accept();
            return new Response(null, { status: 101, webSocket: client });
        });
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route("/recording", recordingReadRoutes)
        .route("/sessions", sessionRoutes)
        .route("/runtimes/:runtimeId", recordingSessionStatusRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/*", projectHandler)
        .all("/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/projects/:projectId", projectRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", projectHandler);

    const application = new Hono<DispatchEnvironment>()
        .use("*", errorMiddleware)
        .use("*", requestTimeoutMiddleware<DispatchEnvironment>(PLATFORM_REQUEST_TIMEOUT_MILLISECONDS))
        .use("*", async (context, next) => {
            const runtimeRoute = await routeRuntimeSessionRequest(context.req.raw, context.env);
            if (runtimeRoute !== null) {
                return runtimeRoute;
            }
            const routed =
                "MOBIUS_RUNTIME_EXECUTION" in context.env
                    ? null
                    : await routeProjectDurableObject(context.req.raw, context.env, authentication.allowedOrigins);
            if (routed !== null) {
                return routed;
            }
            return await next();
        })
        .onError((error) => {
            throw error;
        })
        .use("*", async (context, next) => {
            const environment = context.env;
            const execution =
                "MOBIUS_PROJECT_DATABASE" in environment
                    ? { projectId: environment.MOBIUS_PROJECT_ID, database: environment.MOBIUS_PROJECT_DATABASE }
                    : null;
            const databases = new PlatformDatabaseResolver(environment, execution);
            const projectDatabases = execution === null ? [] : [execution.database];
            const controlStorage = new PlatformControlPlaneStorage(environment.PLATFORM_DIRECTORY_DATABASE, databases);
            const storageRegistry = new PlatformStorageRegistry(environment);
            const appAuthentication = new AppCredentialAuthenticationService(controlStorage, {
                waitUntil: (operation) => {
                    try {
                        context.executionCtx.waitUntil(operation);
                    } catch {
                        // Direct application callers do not provide a Worker execution context.
                        // The already-started operation remains best-effort for those adapters.
                    }
                },
            });
            const control = new PlatformControlPlaneService(
                controlStorage,
                authentication,
                storageRegistry,
                appAuthentication,
                new OrganizationAdministrators(organizations(environment)),
            );
            context.set("control", control);
            context.set("appAuthentication", appAuthentication);
            context.set("sessionAccess", new SessionAccessService(appAuthentication, control));
            context.set(
                "recordingPolicies",
                new RecordingPolicyService(
                    control,
                    new RecordingPolicyStorage(environment.PLATFORM_DIRECTORY_DATABASE),
                    environment.RECORDING !== undefined && isIdentifier(environment.RECORDING_PROVIDER_ID),
                ),
            );
            context.set(
                "appSessionStatusWebhooks",
                new AppSessionStatusWebhookService(
                    control,
                    new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE),
                    environment.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
                ),
            );
            context.set("databases", databases);
            context.set("storageRegistry", storageRegistry);
            context.set("projectDatabases", projectDatabases);
            await next();
        })
        .route(`${MOBIUS_API_PREFIX}/dashboard`, controlRoutes)
        .use("*", initializeSessionAccessTargetMiddleware)
        .use("*", async (context, next) => {
            const environment = context.env;
            const { control, databases, storageRegistry, projectDatabases } = context.var;
            const projects = new PlatformProjectStorageDirectory(storageRegistry);
            const cx = createWorkerContext({
                applications: control,
                gateways: gateways(environment),
                authorization: control,
                databases,
                identityDatabases: projectDatabases,
                projects,
                apiPrefix: MOBIUS_API_PREFIX,
            });
            context.set("relay", cx);
            await next();
        })
        .route(MOBIUS_API_PREFIX, new Hono<DispatchEnvironment>().route("/v1", versionedRoutes))
        .route(`${MOBIUS_API_PREFIX}/v2/projects/:projectId/recording`, recordingSummaryV2Routes)
        .all("*", (context) => projectApplication.fetch(context.req.raw, context.var.relay));
    const platformApplication: Hono<{ Bindings: PlatformApplicationBindings }> = new Hono<{
        Bindings: PlatformApplicationBindings;
    }>()
        .onError((error) => {
            throw error;
        })
        .get(`${MOBIUS_API_PREFIX}/v1/transport`, (context): Response => {
            const executionContext = optionalExecutionContext(context);
            return acceptWebSocketHttpTransport(
                context.req.raw,
                async (request): Promise<Response> =>
                    await platformApplication.fetch(request, context.env, executionContext),
            );
        })
        .all("*", async (context) => {
            const metrics = new RequestAccessMetrics();
            return metrics.appendServerTiming(
                await application.fetch(
                    context.req.raw,
                    instrumentPlatformDatabases(context.env, metrics),
                    optionalExecutionContext(context),
                ),
            );
        });
    return platformApplication;
}

function instrumentPlatformDatabases(
    environment: PlatformRelayBindings,
    metrics: RequestAccessMetrics,
): PlatformRelayBindings {
    return {
        ...environment,
        PLATFORM_DIRECTORY_DATABASE: instrumentD1Database(environment.PLATFORM_DIRECTORY_DATABASE, metrics),
    };
}

export function createPlatformGateways(environment: PlatformApplicationBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
        ...("MOBIUS_RUNTIME_EXECUTION" in environment
            ? { runtimeOperations: environment.MOBIUS_RUNTIME_EXECUTION.operations }
            : {}),
    };
}

export function createPlatformWorker(): {
    readonly fetch: (
        request: Request,
        environment: ConfiguredPlatformRelayBindings | (ConfiguredPlatformRelayBindings & RuntimeExecutionBindings),
        executionContext?: ExecutionContext,
    ) => Promise<Response>;
} {
    const configuredApplications = new Map<string, ReturnType<typeof createPlatformApplication>>();
    return {
        fetch: async (
            request: Request,
            environment: ConfiguredPlatformRelayBindings | (ConfiguredPlatformRelayBindings & RuntimeExecutionBindings),
            executionContext?: ExecutionContext,
        ): Promise<Response> => {
            const key = `${environment.MOBIUS_PLATFORM_ALLOWED_ORIGINS}\u0000${environment.MOBIUS_PLATFORM_OIDC_PROVIDERS}\u0000${environment.MOBIUS_PLATFORM_OPERATOR_SUBJECTS}`;
            const configured = configuredApplications.get(key);
            if (configured !== undefined) {
                return await configured.fetch(request, environment, executionContext);
            }
            const created = createPlatformApplication(
                platformAuthenticationFromEnvironment(environment),
                createPlatformGateways,
            );
            configuredApplications.set(key, created);
            return await created.fetch(request, environment, executionContext);
        },
    };
}

const worker = createPlatformWorker();

export { platformAuthenticationFromEnvironment } from "./composition/platform-authentication-environment.ts";
export { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
export { RuntimeRelay };
export default worker;
