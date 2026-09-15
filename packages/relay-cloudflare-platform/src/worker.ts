import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    createBotApplication,
    createPlatformMobiusApplication,
    createWorkerContext,
    type LiteSessionConfigurationEnvironment,
    PairingDirectoryError,
    type RelayContext,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import { type Handler, Hono } from "hono";
import { BotConnectionActor, PlatformSessionRelay, RuntimeRelay } from "./durable-objects.ts";
import type { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
import { createConversationApplication } from "./http/conversation-routes.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./infra/platform-authentication-environment.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { AppCredentialAuthenticationService } from "./service/app-credential-authentication-service.ts";
import { ConversationAccessService } from "./service/conversation-access-service.ts";
import { ConversationStreamRegistry } from "./service/conversation-stream-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import { SessionAccessService } from "./service/session-access-service.ts";
import { AppCredentialCacheStorage } from "./storage/app-credential-cache-storage.ts";
import { ConversationAccessStorage } from "./storage/conversation-access-storage.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
    platformDatabaseBindings,
} from "./storage/platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./storage/platform-project-authorization-storage.ts";
import { SessionAccessStorage } from "./storage/session-access-storage.ts";

export interface PlatformRelayBindings extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
    readonly APP_CREDENTIAL_CACHE: KVNamespace;
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly D1_SHARD_APAC_01: D1Database;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

export interface ConfiguredPlatformRelayBindings extends PlatformRelayBindings, PlatformAuthenticationEnvironment {}

export interface PlatformWorker {
    readonly fetch: (request: Request, environment: PlatformRelayBindings) => Promise<Response>;
}

class DisabledPublicProjectBootstrap {
    readonly authorize = async (): Promise<void> => {
        throw new PairingDirectoryError(
            "public_project_bootstrap_disabled",
            "Public accountless Project bootstrap is disabled on Platform",
        );
    };
}

const projectApplication = createPlatformMobiusApplication();
const scopedProjectApplication = createProjectApplication();
const botApplication = createBotApplication();
const controlApplication = createPlatformControlApplication();
const conversationApplication = createConversationApplication();

type DispatchEnvironment = {
    readonly Bindings: PlatformRelayBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
        readonly storageRegistry: PlatformStorageRegistry;
        readonly projectDatabases: D1Database[];
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
    };
};

export function createPlatformApplication(
    authentication: PlatformAuthenticationConfiguration,
    gateways: (environment: PlatformRelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: PlatformRelayBindings }> {
    const conversationStreams = new ConversationStreamRegistry();
    const controlHandler: Handler<DispatchEnvironment> = (context) =>
        controlApplication.fetch(context.req.raw, {
            control: context.var.control,
            appAuthentication: context.var.appAuthentication,
            allowedOrigins: authentication.allowedOrigins,
        });
    const conversationHandler: Handler<DispatchEnvironment> = (context) => {
        const { relay, sessionAccess, control, projectDatabases } = context.var;
        if (relay.services.bots === null) {
            throw new Error("Platform Bot services are unavailable");
        }
        return conversationApplication.fetch(context.req.raw, {
            sessionAccess,
            access: new ConversationAccessService(
                new ConversationAccessStorage(context.env.PLATFORM_DIRECTORY_DATABASE, projectDatabases),
                control,
            ),
            allowedOrigins: authentication.allowedOrigins,
            bots: relay.services.bots,
            nowEpochMilliseconds: () => Date.now(),
            sessions: relay.services.sessions,
            streams: conversationStreams,
        });
    };
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
                        .all("/storage-placement/", controlHandler),
                ),
        );
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route(
            "/sessions",
            new Hono<DispatchEnvironment>()
                .all("/:sessionId/access-credentials", conversationHandler)
                .all("/*", projectHandler),
        )
        .all("/browser-credentials/*", projectHandler)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/*", projectHandler)
        .all("/session-imports/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/projects/:projectId", projectRoutes)
        .all("/client/session/*", conversationHandler)
        .all("/conversations/:conversationId/access-credentials", conversationHandler)
        .route(
            "/conversation-access-credentials/:credentialId",
            new Hono<DispatchEnvironment>().all("/rotate", conversationHandler).all("/revoke", conversationHandler),
        )
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", (context) => {
            const bots = context.var.relay.services.bots;
            return bots === null
                ? projectApplication.fetch(context.req.raw, context.var.relay)
                : botApplication.fetch(context.req.raw, { services: { bots } });
        });

    const application = new Hono<DispatchEnvironment>()
        .onError((error) => {
            throw error;
        })
        .use("*", async (context, next) => {
            const environment = context.env;
            const databaseBindings = platformDatabaseBindings(environment);
            const projectDatabases = databaseBindings.map(({ database }) => database);
            const controlStorage = new PlatformControlPlaneStorage(
                environment.PLATFORM_DIRECTORY_DATABASE,
                projectDatabases,
            );
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
                new PlatformProjectAuthorizationStorage(databaseBindings),
            );
            context.set("control", control);
            context.set("appAuthentication", appAuthentication);
            context.set("storageRegistry", storageRegistry);
            context.set("projectDatabases", projectDatabases);
            await next();
        })
        .route(MOBIUS_API_PREFIX, controlRoutes)
        .use("*", async (context, next) => {
            const environment = context.env;
            const { control, storageRegistry, projectDatabases } = context.var;
            const databases = new PlatformDatabaseResolver(environment);
            const projects = new PlatformProjectStorageDirectory(storageRegistry);
            const sessionAccess = new SessionAccessService(
                new SessionAccessStorage(environment.PLATFORM_DIRECTORY_DATABASE),
                control,
            );
            const cx = createWorkerContext({
                gateways: gateways(environment),
                authorization: sessionAccess.authorizer(context.req.raw),
                bootstrap: new DisabledPublicProjectBootstrap(),
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
    return new Hono<{ Bindings: PlatformRelayBindings }>()
        .onError((error) => {
            throw error;
        })
        .route("/", application);
}

export function createPlatformWorker(authentication: PlatformAuthenticationConfiguration): PlatformWorker {
    const app = createPlatformApplication(authentication, createPlatformGateways);
    return { fetch: async (request, environment) => await app.fetch(request, environment) };
}

export function createPlatformGateways(environment: PlatformRelayBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
        sessions: new CloudflareSessionTransport(environment.SESSION_RELAY, "platform"),
        connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
    };
}

const configuredWorkers = new Map<string, PlatformWorker>();

const worker = {
    fetch: async (request: Request, environment: ConfiguredPlatformRelayBindings): Promise<Response> => {
        const key = `${environment.MOBIUS_PLATFORM_ALLOWED_ORIGINS}\u0000${environment.MOBIUS_PLATFORM_OIDC_PROVIDERS}\u0000${environment.MOBIUS_PLATFORM_OPERATOR_SUBJECTS}`;
        const configured = configuredWorkers.get(key);
        if (configured !== undefined) {
            return await configured.fetch(request, environment);
        }
        const created = createPlatformWorker(platformAuthenticationFromEnvironment(environment));
        configuredWorkers.set(key, created);
        return await created.fetch(request, environment);
    },
};

export { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
export { platformAuthenticationFromEnvironment } from "./infra/platform-authentication-environment.ts";
export { BotConnectionActor, PlatformSessionRelay, RuntimeRelay };
export default worker;
