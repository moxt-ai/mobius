import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    acceptWebSocketHttpTransport,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    createMobiusApplication,
    createWorkerContext,
    type HttpError,
    instrumentD1Database,
    type LiteSessionConfigurationEnvironment,
    type RelayContext,
    RequestAccessMetrics,
    requestTimeoutMiddleware,
    type SessionEventReceiver,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import { type Handler, Hono } from "hono";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./composition/platform-authentication-environment.ts";
import { PlatformSessionRelay } from "./durable-objects/platform-session-relay.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import type { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "./entity/platform-project-id.ts";
import {
    type ProjectDurableObjectExecutionBindings,
    type ProjectWorkerRoutingBindings,
    routeProjectDurableObject,
} from "./gateway/project-durable-object-routing.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import { createSessionCredentialRoutes } from "./http/session-credential-routes.ts";
import { ClerkOrganizationGateway } from "./infra/clerk-organization-gateway.ts";
import type { OrganizationMembershipGateway } from "./infra/organization-membership-gateway.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import {
    initializeSessionAccessTargetMiddleware,
    sessionAccessTargetMiddleware,
} from "./middleware/session-access-target.ts";
import { AppCredentialAuthenticationService } from "./service/app-credential-authentication-service.ts";
import { OrganizationInviteService } from "./service/organization-invite-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import { SessionAccessService, type SessionAccessTarget } from "./service/session-access-service.ts";
import { AppCredentialCacheStorage } from "./storage/app-credential-cache-storage.ts";
import { OrganizationInviteStorage } from "./storage/organization-invite-storage.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "./storage/platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./storage/platform-project-authorization-storage.ts";
import { SessionAccessStorage } from "./storage/session-access-storage.ts";

export interface PlatformRelayBindings
    extends LiteSessionConfigurationEnvironment,
        PlatformStorageBindings,
        ProjectWorkerRoutingBindings {
    readonly CLERK_SECRET_KEY?: string;
    readonly APP_CREDENTIAL_CACHE: KVNamespace;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace<PlatformSessionRelay>;
}

export interface ProjectPlatformRelayBindings extends PlatformRelayBindings, ProjectDurableObjectExecutionBindings {}

type PlatformApplicationBindings = PlatformRelayBindings | ProjectPlatformRelayBindings;

export interface ConfiguredPlatformRelayBindings extends PlatformRelayBindings, PlatformAuthenticationEnvironment {}

type LiveEventTarget =
    | { readonly kind: "durable"; readonly projectId: string; readonly runtimeId: string }
    | {
          readonly expiresAtEpochMilliseconds: number;
          readonly kind: "expiring";
          readonly projectId: string;
          readonly runtimeId: string;
      };

export interface LiveSessionEventReceiverFactory {
    readonly create: (receiver: SessionEventReceiver) => SessionEventReceiver;
}

const directLiveSessionEventReceiverFactory: LiveSessionEventReceiverFactory = {
    create: (receiver) => receiver,
};

class LiveEventSubscriptionError extends Error implements HttpError {
    readonly #code: string;
    readonly #status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = "LiveEventSubscriptionError";
        this.#code = code;
        this.#status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.#code, message: this.message } },
        status: this.#status,
    });
}

async function decodeLiveEventTarget(response: Response): Promise<LiveEventTarget> {
    const value: unknown = await response.json();
    if (!response.ok) {
        const error =
            typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "error") : null;
        throw new LiveEventSubscriptionError(
            typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
                ? Reflect.get(error, "code")
                : "subscription_authorization_failed",
            typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string"
                ? Reflect.get(error, "message")
                : "The live Session event subscription could not be authorized",
            response.status,
        );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    const kind = Reflect.get(value, "kind");
    const projectId = Reflect.get(value, "projectId");
    const runtimeId = Reflect.get(value, "runtimeId");
    if ((kind !== "durable" && kind !== "expiring") || typeof projectId !== "string" || typeof runtimeId !== "string") {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    if (kind === "durable") {
        return { kind, projectId, runtimeId };
    }
    const expiresAtEpochMilliseconds = Reflect.get(value, "expiresAtEpochMilliseconds");
    if (typeof expiresAtEpochMilliseconds !== "number" || !Number.isSafeInteger(expiresAtEpochMilliseconds)) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    return { expiresAtEpochMilliseconds, kind, projectId, runtimeId };
}

async function subscribeToLiveEvents(
    request: Request,
    receive: SessionEventReceiver,
    signal: AbortSignal,
    dispatch: (request: Request) => Promise<Response>,
    environment: PlatformRelayBindings,
    receiverFactory: LiveSessionEventReceiverFactory,
): Promise<{ readonly unsubscribe: () => Promise<void> }> {
    const path = new URL(request.url).pathname;
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    const segments = path.slice(prefix.length).split("/");
    if (!path.startsWith(prefix) || segments.length !== 4 || segments[1] !== "sessions") {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 400);
    }
    const sessionId = segments[2];
    if (sessionId === undefined) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 400);
    }
    const target = await decodeLiveEventTarget(await dispatch(request));
    signal.throwIfAborted();
    const id = environment.SESSION_RELAY.idFromName(`platform:${target.projectId}:${sessionId}`);
    const locationHint = decodePlatformProjectPlacement(target.projectId)?.locationHint;
    const stub =
        locationHint === undefined
            ? environment.SESSION_RELAY.get(id)
            : environment.SESSION_RELAY.get(id, { locationHint });
    const subscriptionId = crypto.randomUUID();
    let resolveReady = (): void => undefined;
    let rejectReady = (_cause: unknown): void => undefined;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const receiver = receiverFactory.create({
        receive: async (message) => {
            await receive.receive(message);
            if (message.kind === "ready") {
                resolveReady();
            }
        },
    });
    const operation = stub.subscribeToLiveSessionEvents(
        subscriptionId,
        target.projectId,
        target.runtimeId,
        sessionId,
        receiver,
    );
    let state: { readonly kind: "opening" } | { readonly kind: "open" } | { readonly kind: "closed" } = {
        kind: "opening",
    };
    void operation.catch((cause: unknown) => {
        switch (state.kind) {
            case "opening":
                rejectReady(cause);
                return;
            case "open":
                state = { kind: "closed" };
                void receive.receive({ kind: "end" }).catch(() => undefined);
                return;
            case "closed":
                return;
        }
    });
    await ready;
    if (state.kind === "opening") {
        state = { kind: "open" };
    }
    const unsubscribe = async (): Promise<void> => {
        switch (state.kind) {
            case "opening":
            case "open":
                state = { kind: "closed" };
                await stub.unsubscribeFromLiveSessionEvents(subscriptionId);
                await operation;
                return;
            case "closed":
                return;
        }
    };
    const timer =
        target.kind === "expiring"
            ? setTimeout(
                  () => void unsubscribe().catch(() => undefined),
                  Math.max(0, target.expiresAtEpochMilliseconds - Date.now()),
              )
            : null;
    return {
        unsubscribe: async () => {
            if (timer !== null) {
                clearTimeout(timer);
            }
            await unsubscribe();
        },
    };
}

const projectApplication = createMobiusApplication();
const scopedProjectApplication = createProjectApplication();
const controlApplication = createPlatformControlApplication();
const PLATFORM_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

type DispatchEnvironment = {
    readonly Bindings: PlatformApplicationBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
        readonly databases: PlatformDatabaseResolver;
        readonly storageRegistry: PlatformStorageRegistry;
        readonly projectDatabases: import("@moxt-ai/mobius-relay-core/database").SqlDatabase[];
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
};

export function createPlatformApplication(
    authentication: PlatformAuthenticationConfiguration,
    gateways: (environment: PlatformRelayBindings) => WorkerRuntimeGateways,
    organizations: (environment: PlatformRelayBindings) => OrganizationMembershipGateway = (environment) =>
        new ClerkOrganizationGateway(environment.CLERK_SECRET_KEY),
    receiverFactory: LiveSessionEventReceiverFactory = directLiveSessionEventReceiverFactory,
): Hono<{ Bindings: PlatformApplicationBindings }> {
    const controlHandler: Handler<DispatchEnvironment> = (context) =>
        controlApplication.fetch(context.req.raw, {
            control: context.var.control,
            appAuthentication: context.var.appAuthentication,
            allowedOrigins: authentication.allowedOrigins,
            invites: new OrganizationInviteService(
                new OrganizationInviteStorage(context.env.PLATFORM_DIRECTORY_DATABASE),
                organizations(context.env),
            ),
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
                        .all("/audit-events/", controlHandler),
                ),
        );
    const sessionRoutes = new Hono<DispatchEnvironment>()
        .route("/", createSessionCredentialRoutes(authentication.allowedOrigins))
        .get("/:sessionId", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/messages", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/files/content", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/native-messages", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/events", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/live-event-subscription-target", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/interactions", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/interactions/:interactionId", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/turns/:turnId", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/artifacts/:artifactId", sessionAccessTargetMiddleware, projectHandler)
        .get("/:sessionId/artifacts/:artifactId/content", sessionAccessTargetMiddleware, projectHandler)
        .post("/:sessionId/turns", sessionAccessTargetMiddleware, projectHandler)
        .post("/:sessionId/prepare", sessionAccessTargetMiddleware, projectHandler)
        .post("/:sessionId/configuration", sessionAccessTargetMiddleware, projectHandler)
        .post("/:sessionId/turns/:turnId/cancel", sessionAccessTargetMiddleware, projectHandler)
        .post("/:sessionId/interactions/:interactionId/responses", sessionAccessTargetMiddleware, projectHandler)
        .all("/*", projectHandler);
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route("/sessions", sessionRoutes)
        .all("/browser-credentials/*", projectHandler)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/*", projectHandler)
        .all("/session-imports/*", projectHandler)
        .all("/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/projects/:projectId", projectRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", projectHandler);

    const application = new Hono<DispatchEnvironment>()
        .use("*", requestTimeoutMiddleware<DispatchEnvironment>(PLATFORM_REQUEST_TIMEOUT_MILLISECONDS))
        .use("*", async (context, next) => {
            const routed = await routeProjectDurableObject(context.req.raw, context.env, authentication.allowedOrigins);
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
            const appAuthentication = new AppCredentialAuthenticationService(
                controlStorage,
                new AppCredentialCacheStorage(environment.APP_CREDENTIAL_CACHE),
            );
            const control = new PlatformControlPlaneService(
                controlStorage,
                authentication,
                storageRegistry,
                appAuthentication,
                new PlatformProjectAuthorizationStorage(databases),
            );
            context.set("control", control);
            context.set("appAuthentication", appAuthentication);
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
            const sessionAccess = new SessionAccessService(
                new SessionAccessStorage(environment.PLATFORM_DIRECTORY_DATABASE, databases),
                control,
            );
            const cx = createWorkerContext({
                gateways: gateways(environment),
                authorization: sessionAccess.authorizer(() => context.var.sessionAccessTarget),
                databases,
                identityDatabases: projectDatabases,
                projects,
                apiPrefix: MOBIUS_API_PREFIX,
                quotaPolicy: control,
            });
            context.set("relay", cx);
            context.set("sessionAccess", sessionAccess);
            await next();
        })
        .route(MOBIUS_API_PREFIX, new Hono<DispatchEnvironment>().route("/v1", versionedRoutes))
        .all("*", (context) => projectApplication.fetch(context.req.raw, context.var.relay));
    const platformApplication: Hono<{ Bindings: PlatformApplicationBindings }> = new Hono<{
        Bindings: PlatformApplicationBindings;
    }>()
        .onError((error) => {
            throw error;
        })
        .get(
            `${MOBIUS_API_PREFIX}/v1/transport`,
            (context): Response =>
                acceptWebSocketHttpTransport(
                    context.req.raw,
                    async (request): Promise<Response> => await platformApplication.fetch(request, context.env),
                    async (request, receive, signal) =>
                        await subscribeToLiveEvents(
                            request,
                            receive,
                            signal,
                            async (authorizationRequest) =>
                                await platformApplication.fetch(authorizationRequest, context.env),
                            context.env,
                            receiverFactory,
                        ),
                ),
        )
        .all("*", async (context) => {
            const metrics = new RequestAccessMetrics();
            return metrics.appendServerTiming(
                await application.fetch(context.req.raw, instrumentPlatformDatabases(context.env, metrics)),
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

export function createPlatformGateways(environment: PlatformRelayBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
        sessions: new CloudflareSessionTransport(
            environment.SESSION_RELAY,
            "platform",
            (projectId) => decodePlatformProjectPlacement(projectId)?.locationHint,
        ),
    };
}

export function createPlatformWorker(
    receiverFactory: LiveSessionEventReceiverFactory = directLiveSessionEventReceiverFactory,
): { readonly fetch: (request: Request, environment: ConfiguredPlatformRelayBindings) => Promise<Response> } {
    const configuredApplications = new Map<string, ReturnType<typeof createPlatformApplication>>();
    return {
        fetch: async (request: Request, environment: ConfiguredPlatformRelayBindings): Promise<Response> => {
            const key = `${environment.MOBIUS_PLATFORM_ALLOWED_ORIGINS}\u0000${environment.MOBIUS_PLATFORM_OIDC_PROVIDERS}\u0000${environment.MOBIUS_PLATFORM_OPERATOR_SUBJECTS}`;
            const configured = configuredApplications.get(key);
            if (configured !== undefined) {
                return await configured.fetch(request, environment);
            }
            const created = createPlatformApplication(
                platformAuthenticationFromEnvironment(environment),
                createPlatformGateways,
                undefined,
                receiverFactory,
            );
            configuredApplications.set(key, created);
            return await created.fetch(request, environment);
        },
    };
}

const worker = createPlatformWorker();

export { platformAuthenticationFromEnvironment } from "./composition/platform-authentication-environment.ts";
export { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
export { PlatformSessionRelay, RuntimeRelay };
export default worker;
