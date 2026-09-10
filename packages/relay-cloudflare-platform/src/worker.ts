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
    ConfiguredPairingTenantResolver,
    createBotApplication,
    createPlatformMobiusApplication,
    createRelayDependencies,
    PairingDirectoryError,
} from "@moxt-ai/mobius-relay-core";
import { D1ConversationAccess } from "./conversation-access.ts";
import { createConversationApplication } from "./conversation-routes.ts";
import { ConversationStreamRegistry } from "./conversation-streams.ts";
import { BotConnectionActor, PlatformSessionRelay, RuntimeRelay } from "./durable-objects.ts";
import { PlatformDatabaseResolver, PlatformTenantShardingDirectory } from "./infrastructure.ts";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./platform-authentication-environment.ts";
import { D1PlatformControlPlane, type PlatformAuthenticationConfiguration } from "./platform-control-plane.ts";
import { createPlatformControlApplication } from "./platform-routes.ts";

export interface PlatformRelayBindings extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
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
        /^\/mobius\/api\/v1\/conversation-access-credentials\/[^/]+\/(?:rotate|revoke)$/.test(pathname) ||
        /^\/mobius\/api\/v1\/platform\/projects\/[^/]+\/conversation-access-credentials(?:\/|$)/.test(pathname) ||
        /^\/mobius\/api\/v1\/platform\/conversation-access-credentials\/[^/]+\/(?:rotate|revoke)$/.test(pathname)
    );
}

function isLegacyAuthenticationPath(pathname: string): boolean {
    if (
        pathname === `${MOBIUS_API_PREFIX}/v1/projects` ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/auth/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-applications/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-application-credentials/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-owner-credentials/`)
    ) {
        return true;
    }
    return /^\/mobius\/api\/v1\/projects\/[^/]+\/(?:applications|external-identity-bindings|owner-credentials|authentication-audit-events)(?:\/|$)/.test(
        pathname,
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
            const control = new D1PlatformControlPlane(
                environment.PLATFORM_DIRECTORY_DATABASE,
                authentication,
                environment.DIRECTORY_DATABASE,
            );
            const pathname = new URL(request.url).pathname;
            if (isControlPath(pathname) && !isConversationPath(pathname)) {
                return await controlApplication.fetch(request, { control });
            }
            if (pathname === `${MOBIUS_API_PREFIX}/pairings`) {
                return new Response("Not Found", { status: 404 });
            }
            if (isLegacyAuthenticationPath(pathname)) {
                return new Response("Not Found", { status: 404 });
            }

            const databases = new PlatformDatabaseResolver(environment.DIRECTORY_DATABASE);
            const tenants = new PlatformTenantShardingDirectory();
            const infrastructure = {
                config: { quota: sessionQuotaFromEnvironment(environment) },
                gateways: {
                    databaseResolver: databases,
                    tenantShardingDirectory: tenants,
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
                identityDatabases: [D1DatabaseAdapter.from(environment.DIRECTORY_DATABASE)],
                logger: console,
                gateways: {
                    channelGateway: channelRuntime,
                    nowEpochMilliseconds: () => Date.now(),
                    pairingTenantResolver: new ConfiguredPairingTenantResolver("platform"),
                    publicProjectBootstrap: new DisabledPublicProjectBootstrap(),
                    sessionTransport: new CloudflareSessionTransport(environment.SESSION_RELAY),
                },
                tenants,
            });
            if (isConversationPath(pathname)) {
                if (cx.services.bots === null) {
                    throw new Error("Platform Bot services are unavailable");
                }
                return await conversationApplication.fetch(request, {
                    access: new D1ConversationAccess(
                        environment.PLATFORM_DIRECTORY_DATABASE,
                        environment.DIRECTORY_DATABASE,
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

export { platformAuthenticationFromEnvironment } from "./platform-authentication-environment.ts";
export { PlatformAuthenticationConfiguration } from "./platform-control-plane.ts";
export { BotConnectionActor, PlatformSessionRelay, RuntimeRelay };
export default worker;
