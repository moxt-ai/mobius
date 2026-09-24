import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    acceptWebSocketHttpTransport,
    CloudflareChannelRuntime,
    createMobiusApplication,
    createWorkerContext,
    instrumentD1Database,
    type RelayContext,
    RequestAccessMetrics,
    requestTimeoutMiddleware,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import { type Handler, Hono } from "hono";
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
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import { ClerkOrganizationGateway } from "./infra/clerk-organization-gateway.ts";
import type { OrganizationMembershipGateway } from "./infra/organization-membership-gateway.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { AppCredentialAuthenticationService } from "./service/app-credential-authentication-service.ts";
import { OrganizationInviteService } from "./service/organization-invite-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import { AppCredentialCacheStorage } from "./storage/app-credential-cache-storage.ts";
import { OrganizationInviteStorage } from "./storage/organization-invite-storage.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "./storage/platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./storage/platform-project-authorization-storage.ts";

export interface PlatformRelayBindings extends PlatformStorageBindings, ProjectWorkerRoutingBindings {
    readonly CLERK_SECRET_KEY?: string;
    readonly APP_CREDENTIAL_CACHE: KVNamespace;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly RUNTIME_RELAY: DurableObjectNamespace<RuntimeRelay>;
}

export interface ProjectPlatformRelayBindings extends PlatformRelayBindings, ProjectDurableObjectExecutionBindings {}

type PlatformApplicationBindings = PlatformRelayBindings | ProjectPlatformRelayBindings;

export interface ConfiguredPlatformRelayBindings extends PlatformRelayBindings, PlatformAuthenticationEnvironment {}

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
        readonly signal: AbortSignal;
    };
};

export function createPlatformApplication(
    authentication: PlatformAuthenticationConfiguration,
    gateways: (environment: PlatformRelayBindings) => WorkerRuntimeGateways,
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
    const projectRoutes = new Hono<DispatchEnvironment>()
        .all("/browser-credentials/*", projectHandler)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/*", projectHandler)
        .all("/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/projects/:projectId", projectRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", projectHandler);

    const application = new Hono<DispatchEnvironment>()
        .use("*", requestTimeoutMiddleware<DispatchEnvironment>(PLATFORM_REQUEST_TIMEOUT_MILLISECONDS))
        .use("*", async (context, next) => {
            const path = new URL(context.req.url).pathname;
            if (/\/v1\/projects\/[^/]+\/sessions(?:\/|$)/u.test(path)) {
                return context.json(
                    { error: { code: "session_unavailable", message: "Cloud Sessions are unavailable." } },
                    410,
                );
            }
            return await next();
        })
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
    };
}

export function createPlatformWorker(): {
    readonly fetch: (request: Request, environment: ConfiguredPlatformRelayBindings) => Promise<Response>;
} {
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
            );
            configuredApplications.set(key, created);
            return await created.fetch(request, environment);
        },
    };
}

const worker = createPlatformWorker();

export { platformAuthenticationFromEnvironment } from "./composition/platform-authentication-environment.ts";
export { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
export { RuntimeRelay };
export default worker;
