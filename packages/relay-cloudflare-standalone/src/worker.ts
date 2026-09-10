import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    D1DatabaseAdapter,
    D1ProjectAuthentication,
    type LiteSessionConfigurationEnvironment,
    type PublicProjectBootstrapEnvironment,
    publicProjectBootstrapPolicyFromEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import {
    ConfiguredPairingTenantResolver,
    createBotApplication,
    createMobiusApplication,
    createRelayDependencies,
    type ExternalIdentityAuthenticator,
    ExternalIdentityAuthenticatorRegistry,
} from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay } from "./durable-objects.ts";
import { StandaloneTenantShardingDirectory } from "./tenant-sharding-directory.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment, PublicProjectBootstrapEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly MOBIUS_TENANT_ID?: string;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const application = createMobiusApplication();
const botApplication = createBotApplication();

export class StandaloneAuthenticationConfiguration {
    readonly externalIdentityAuthenticator: ExternalIdentityAuthenticator;

    constructor(externalIdentityAuthenticator: ExternalIdentityAuthenticator) {
        this.externalIdentityAuthenticator = externalIdentityAuthenticator;
    }
}

export interface StandaloneWorker {
    readonly fetch: (request: Request, environment: RelayBindings) => Promise<Response>;
}

export function createStandaloneWorker(authentication: StandaloneAuthenticationConfiguration): StandaloneWorker {
    return {
        fetch: async (request, environment) => {
            const projectAuthentication = new D1ProjectAuthentication(environment.DIRECTORY_DATABASE);
            const infrastructure = {
                config: { quota: sessionQuotaFromEnvironment(environment) },
                gateways: {
                    databaseResolver: new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
                    tenantShardingDirectory: new StandaloneTenantShardingDirectory(),
                    runtimeRelay: environment.RUNTIME_RELAY,
                    sessionRelay: environment.SESSION_RELAY,
                },
            };
            const channelRuntime = new CloudflareChannelRuntime(infrastructure);
            const tenantResolver = new ConfiguredPairingTenantResolver(environment.MOBIUS_TENANT_ID);
            const cx = createRelayDependencies({
                authentication: {
                    externalIdentities: authentication.externalIdentityAuthenticator,
                    projects: projectAuthentication,
                },
                bots: {
                    connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
                },
                config: { apiPrefix: MOBIUS_API_PREFIX, quota: infrastructure.config.quota },
                databases: infrastructure.gateways.databaseResolver,
                identityDatabases: [D1DatabaseAdapter.from(environment.DIRECTORY_DATABASE)],
                logger: console,
                gateways: {
                    channelGateway: channelRuntime,
                    nowEpochMilliseconds: () => Date.now(),
                    pairingTenantResolver: tenantResolver,
                    publicProjectBootstrap: publicProjectBootstrapPolicyFromEnvironment(
                        environment.DIRECTORY_DATABASE,
                        environment,
                    ),
                    sessionTransport: new CloudflareSessionTransport(environment.SESSION_RELAY),
                },
                tenants: infrastructure.gateways.tenantShardingDirectory,
            });
            if (new URL(request.url).pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`) && cx.services.bots !== null) {
                return await botApplication.fetch(request, {
                    services: {
                        bots: cx.services.bots,
                        externalIdentityAuthenticator: cx.services.externalIdentityAuthenticator,
                        projectAuthentication: cx.services.projectAuthentication,
                    },
                });
            }
            return await application.fetch(request, cx);
        },
    };
}

const worker: ExportedHandler<RelayBindings> = createStandaloneWorker(
    new StandaloneAuthenticationConfiguration(new ExternalIdentityAuthenticatorRegistry([])),
);

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
