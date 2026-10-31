import type { LocalSessionOperations, ProjectStore } from "@moxt-ai/mobius-relay-core";
import {
    CloudflareChannelRuntime,
    createMobiusApplication,
    createWorkerContext,
    decodeSessionRequest,
    errorMiddleware,
    instrumentD1Database,
    interactionResponseRequest,
    PairingDirectoryError,
    ProjectPermission,
    ProjectScope,
    type RelayContext,
    RequestAccessMetrics,
    requestTimeoutMiddleware,
    type SessionBindingRequest,
    SessionControl,
    sessionConfigurationRequest,
    sessionRenameRequest,
    type TurnAdmission,
    turnSteerRequest,
    turnSubmissionRequest,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    type Identifier,
    isDirectoryIdentifier,
    isIdentifier,
    MOBIUS_API_PREFIX,
    type TurnState,
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
import { ProjectDurableObjectStores } from "./gateway/project-durable-object-store.ts";
import { routeRuntimeSessionRequest } from "./gateway/runtime-session-routing.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import { recordingReadRoutes, recordingSummaryV2Routes } from "./http/recording-read-routes.ts";
import { authorizeSessionContentUpload } from "./http/session-content-upload.ts";
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
import { type PlatformStorageBindings, PlatformStorageRegistry } from "./storage/platform-storage-registry.ts";
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

// A request a Session credential authorizes is routed to its Runtime's RuntimeRelay before any Session route runs.
function sessionOperations(context: { readonly env: PlatformApplicationBindings }) {
    if (!("MOBIUS_RUNTIME_EXECUTION" in context.env)) {
        throw new Error("Session operations run only in the Runtime's RuntimeRelay");
    }
    return context.env.MOBIUS_RUNTIME_EXECUTION.operations;
}

/** Session operations on the Runtime a Session credential authorized. */
function authorizedSessionControl(
    context: {
        readonly env: PlatformApplicationBindings;
        readonly var: { readonly relay: RelayContext };
        readonly req: { readonly raw: Request };
    },
    access: { readonly projectId: string; readonly runtimeId: string },
    sessionId: string,
): SessionControl {
    const scope = new ProjectScope(access.projectId);
    return new SessionControl(
        async (command) =>
            await sessionOperations(context).requestProjectScopeControl(
                scope,
                access.runtimeId,
                command,
                context.req.raw.signal,
            ),
        sessionId,
    );
}

/**
 * The Turn state a submission reply states, as of `answeredAt`. A retried command that already settled is answered
 * without how or when it ended, so its Turn is indeterminate rather than running: the command's own lifecycle events,
 * or the Session execution naming it, carry its outcome.
 */
function submittedTurnState(state: TurnAdmission["state"], answeredAt: string): TurnState {
    switch (state) {
        case "queued":
            return { kind: "queued" };
        case "running":
            return { kind: "running", startedAt: answeredAt };
        case "settled":
            return {
                kind: "indeterminate",
                reconciliation: { detectedAt: answeredAt, reason: "dispatch_indeterminate" },
            };
    }
}

const projectApplication = createMobiusApplication();
const scopedProjectApplication = createProjectApplication();
const controlApplication = createPlatformControlApplication();
const PLATFORM_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const sessionIdentifier = v.custom<Identifier>(isIdentifier);
/**
 * A Session binding stated in a query string. Each omitted field is the Session's own. A query cannot tell an empty
 * list from an omitted one; callers that state the binding send no `additionalDirectoryId` for an empty list, so with
 * `agentId` or `directoryId` present an absent list is empty.
 */
function sessionBindingQuery(request: {
    readonly query: (name: string) => string | undefined;
    readonly queries: (name: string) => string[] | undefined;
}): SessionBindingRequest {
    const agentId = request.query("agentId");
    const directoryId = request.query("directoryId");
    const additionalDirectoryIds = request.queries("additionalDirectoryId");
    return {
        additionalDirectoryIds:
            additionalDirectoryIds === undefined && agentId === undefined && directoryId === undefined
                ? undefined
                : v.parse(
                      v.pipe(v.array(v.custom<string>(isDirectoryIdentifier)), v.maxLength(16)),
                      additionalDirectoryIds ?? [],
                  ),
        agentId: agentId === undefined ? undefined : v.parse(sessionIdentifier, agentId),
        directoryId:
            directoryId === undefined ? undefined : v.parse(v.custom<string>(isDirectoryIdentifier), directoryId),
    };
}

type DispatchEnvironment = {
    readonly Bindings: PlatformApplicationBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
        readonly stores: ProjectDurableObjectStores;
        readonly projects: PlatformProjectStorageDirectory;
        readonly identityStores: readonly ProjectStore[];
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

export function createPlatformAccessServices(
    environment: PlatformApplicationBindings,
    authentication: PlatformAuthenticationConfiguration,
    organizations: (environment: PlatformRelayBindings) => OrganizationMembershipGateway = (bindings) =>
        new ClerkOrganizationGateway(bindings.CLERK_SECRET_KEY),
) {
    const execution =
        "MOBIUS_PROJECT_STORE" in environment
            ? { projectId: environment.MOBIUS_PROJECT_ID, store: environment.MOBIUS_PROJECT_STORE }
            : null;
    const stores = new ProjectDurableObjectStores(environment.PROJECT_RELAY, execution);
    const identityStores = execution === null ? [] : [execution.store];
    const controlStorage = new PlatformControlPlaneStorage(environment.PLATFORM_DIRECTORY_DATABASE, stores);
    const storageRegistry = new PlatformStorageRegistry(environment);
    const appAuthentication = new AppCredentialAuthenticationService(controlStorage);
    const control = new PlatformControlPlaneService(
        controlStorage,
        authentication,
        storageRegistry,
        appAuthentication,
        new OrganizationAdministrators(organizations(environment)),
    );
    return {
        stores,
        identityStores,
        control,
        appAuthentication,
        sessionAccess: new SessionAccessService(appAuthentication, control),
        projects: new PlatformProjectStorageDirectory(storageRegistry, controlStorage),
    };
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
            const eventLimit = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                Number(context.req.query("eventLimit") ?? "50"),
            );
            const control = authorizedSessionControl(context, access, sessionId);
            const events = await control.previewEvents(sessionBindingQuery(context.req), {
                cursor: context.req.query("cursor") ?? null,
                eventLimit,
            });
            context.header("Cache-Control", "no-store");
            return context.json(events);
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
            const control = authorizedSessionControl(context, access, sessionId);
            const result = await control.readConfiguration();
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
            const binding = sessionBindingQuery(context.req);
            const commandId = context.req.query("commandId");
            const control = authorizedSessionControl(context, access, sessionId);
            const result = await control.activeTurn(
                binding,
                commandId === undefined ? undefined : v.parse(sessionIdentifier, commandId),
            );
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
            const body = decodeSessionRequest(turnSubmissionRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            const accepted = await control.submitTurn({ ...body, commandId: body.idempotencyKey });
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
                state: submittedTurnState(accepted.state, acceptedAt),
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
            decodeSessionRequest(turnSteerRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            await control.steerTurn(turnId);
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
        .put("/:sessionId/content/:contentKey", async (context) => {
            const authorized = await authorizeSessionContentUpload(context.req.raw, context.var.sessionAccess);
            if (authorized instanceof Response) {
                return authorized;
            }
            const { access, sessionId, contentKey } = authorized;
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
            const body = decodeSessionRequest(sessionConfigurationRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            const result = await control.configure(body);
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
            const body = decodeSessionRequest(sessionRenameRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            const result = await control.rename(body.title);
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/turns/:turnId/cancel-before-start", sessionAccessTargetMiddleware, async (context) => {
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
            const control = authorizedSessionControl(context, access, sessionId);
            await control.withdrawTurn(turnId);
            context.header("Cache-Control", "no-store");
            return context.json({ turnId });
        })
        .post("/:sessionId/turns/:turnId/cancel", sessionAccessTargetMiddleware, async (context) => {
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
            const control = authorizedSessionControl(context, access, sessionId);
            const { stopReason } = await control.cancelTurn(turnId);
            context.header("Cache-Control", "no-store");
            return context.json({ turnId, stopReason });
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
            const body = decodeSessionRequest(interactionResponseRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            await control.respond(interactionId, body);
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
                const events = await authorizedSessionControl(
                    context,
                    target,
                    v.parse(sessionIdentifier, context.req.param("sessionId")),
                ).liveEvents({
                    cursor: context.req.query("cursor") ?? null,
                    eventLimit: v.parse(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                        Number(context.req.query("limit") ?? "50"),
                    ),
                });
                context.header("Cache-Control", "no-store");
                return context.json(events);
            }
            return await sessionOperations(context).openPublicSessionEvents(
                new ProjectScope(target.projectId),
                target.runtimeId,
                context.req.param("sessionId"),
                target.expiresAtEpochMilliseconds,
                context.req.raw.signal,
            );
        });
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route("/recording", recordingReadRoutes)
        .route("/sessions", sessionRoutes)
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
            const { stores, identityStores, control, appAuthentication, sessionAccess, projects } =
                createPlatformAccessServices(environment, authentication, organizations);
            context.set("control", control);
            context.set("appAuthentication", appAuthentication);
            context.set("sessionAccess", sessionAccess);
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
            context.set("stores", stores);
            context.set("projects", projects);
            context.set("identityStores", identityStores);
            await next();
        })
        .route(`${MOBIUS_API_PREFIX}/dashboard`, controlRoutes)
        .use("*", initializeSessionAccessTargetMiddleware)
        .use("*", async (context, next) => {
            const environment = context.env;
            const { control, stores, projects, identityStores } = context.var;
            const cx = createWorkerContext({
                applications: control,
                gateways: gateways(environment),
                authorization: control,
                stores,
                identityStores,
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

export function createPlatformWorker() {
    const configuredApplications = new Map<string, ReturnType<typeof createPlatformApplication>>();
    return {
        fetch: async (
            request: Request,
            environment: ConfiguredPlatformRelayBindings,
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
