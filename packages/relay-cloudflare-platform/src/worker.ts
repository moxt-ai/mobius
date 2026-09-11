import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    D1DatabaseAdapter,
    type LiteSessionConfigurationEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import {
    createBotApplication,
    createPlatformMobiusApplication,
    createRelayDependencies,
    PairingDirectoryError,
} from "@moxt-ai/mobius-relay-core";
import { BotConnectionActor, PlatformSessionRelay, RuntimeRelay } from "./durable-objects.ts";
import type { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
import { createConversationApplication } from "./http/conversation-routes.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./infra/platform-authentication-environment.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { ConversationAccessService } from "./service/conversation-access-service.ts";
import { ConversationStreamRegistry } from "./service/conversation-stream-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import { ConversationAccessStorage } from "./storage/conversation-access-storage.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
    platformDatabaseBindings,
} from "./storage/platform-database-resolver.ts";

export interface PlatformRelayBindings extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
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
const botApplication = createBotApplication();
const controlApplication = createPlatformControlApplication();
const conversationApplication = createConversationApplication();

function isControlPath(pathname: string): boolean {
    return (
        pathname === `${MOBIUS_API_PREFIX}/health` ||
        pathname === `${MOBIUS_API_PREFIX}/capabilities` ||
        pathname === `${MOBIUS_API_PREFIX}/v1/apps` ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/apps/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/platform/`) ||
        pathname === `${MOBIUS_API_PREFIX}/v1/platform`
    );
}

function isConversationPath(pathname: string): boolean {
    return (
        pathname === `${MOBIUS_API_PREFIX}/v1/client/session` ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/client/session/`) ||
        /^\/mobius\/api\/v1\/conversations\/[^/]+\/access-credentials$/.test(pathname) ||
        /^\/mobius\/api\/v1\/conversation-access-credentials\/[^/]+\/(?:rotate|revoke)$/.test(pathname)
    );
}

function isVersionedSharedProjectPath(pathname: string): boolean {
    return (
        /^\/mobius\/api\/v1\/projects\/[^/]+\/(?:browser-credentials|runtime-pairings|runtimes|session-imports|sessions)(?:\/|$)/.test(
            pathname,
        ) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/runtime-pairings/`) ||
        pathname === `${MOBIUS_API_PREFIX}/v1/runtimes/connect`
    );
}

export function createPlatformWorker(authentication: PlatformAuthenticationConfiguration): PlatformWorker {
    const conversationStreams = new ConversationStreamRegistry();
    return {
        fetch: async (request, environment) => {
            const databaseBindings = platformDatabaseBindings(environment);
            const projectDatabases = databaseBindings.map(({ database }) => database);
            const controlStorage = new PlatformControlPlaneStorage(
                environment.PLATFORM_DIRECTORY_DATABASE,
                projectDatabases,
            );
            const storageRegistry = new PlatformStorageRegistry(environment);
            const control = new PlatformControlPlaneService(controlStorage, authentication, storageRegistry);
            const pathname = new URL(request.url).pathname;
            if (isControlPath(pathname) && !isConversationPath(pathname)) {
                return await controlApplication.fetch(request, { control });
            }
            const databases = new PlatformDatabaseResolver(environment);
            const projects = new PlatformProjectStorageDirectory(
                { read: controlStorage.readProjectStoragePlacement },
                storageRegistry,
            );
            const infrastructure = {
                config: { quota: sessionQuotaFromEnvironment(environment) },
                gateways: {
                    databaseResolver: databases,
                    projectStorageDirectory: projects,
                    runtimeRelay: environment.RUNTIME_RELAY,
                    sessionRelay: environment.SESSION_RELAY,
                },
            };
            const channelRuntime = new CloudflareChannelRuntime(infrastructure);
            const cx = createRelayDependencies({
                authentication: {
                    projects: control,
                },
                bots: {
                    connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
                },
                config: { apiPrefix: MOBIUS_API_PREFIX, quotaPolicy: control },
                databases,
                identityDatabases: projectDatabases.map((database) => D1DatabaseAdapter.from(database)),
                logger: console,
                gateways: {
                    channelGateway: channelRuntime,
                    nowEpochMilliseconds: () => Date.now(),
                    publicProjectBootstrap: new DisabledPublicProjectBootstrap(),
                    sessionTransport: new CloudflareSessionTransport(environment.SESSION_RELAY, "platform"),
                },
                projects,
            });
            if (isConversationPath(pathname)) {
                if (cx.services.bots === null) {
                    throw new Error("Platform Bot services are unavailable");
                }
                return await conversationApplication.fetch(request, {
                    access: new ConversationAccessService(
                        new ConversationAccessStorage(environment.PLATFORM_DIRECTORY_DATABASE, projectDatabases),
                        control,
                    ),
                    allowedOrigins: authentication.allowedOrigins,
                    bots: cx.services.bots,
                    nowEpochMilliseconds: () => Date.now(),
                    sessions: cx.services.sessions,
                    streams: conversationStreams,
                });
            }
            if (isVersionedSharedProjectPath(pathname)) {
                return await projectApplication.fetch(request, cx);
            }
            if (pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`) && cx.services.bots !== null) {
                return await botApplication.fetch(request, {
                    services: { bots: cx.services.bots },
                });
            }
            return await projectApplication.fetch(request, cx);
        },
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
