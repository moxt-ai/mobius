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
    createMobiusApplication,
    createRelayDependencies,
} from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay } from "./durable-objects.ts";
import { StandaloneTenantShardingDirectory } from "./tenant-sharding-directory.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly MOBIUS_TENANT_ID?: string;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const application = createMobiusApplication();
const botApplication = createBotApplication();

const worker: ExportedHandler<RelayBindings> = {
    fetch: async (request, environment) => {
        const infrastructure = {
            config: { quota: sessionQuotaFromEnvironment(environment) },
            gateways: {
                sessionRelay: environment.SESSION_RELAY,
                databaseResolver: new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
                tenantShardingDirectory: new StandaloneTenantShardingDirectory(),
                runtimeRelay: environment.RUNTIME_RELAY,
            },
        };
        const channelRuntime = new CloudflareChannelRuntime(infrastructure);
        const tenantResolver = new ConfiguredPairingTenantResolver(environment.MOBIUS_TENANT_ID);
        const cx = createRelayDependencies({
            bots: {
                connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
            },
            databases: infrastructure.gateways.databaseResolver,
            tenants: infrastructure.gateways.tenantShardingDirectory,
            identityDatabases: [D1DatabaseAdapter.from(environment.DIRECTORY_DATABASE)],
            config: { apiPrefix: MOBIUS_API_PREFIX, quota: infrastructure.config.quota },
            logger: console,
            gateways: {
                nowEpochMilliseconds: () => Date.now(),
                channelGateway: channelRuntime,
                pairingTenantResolver: tenantResolver,
                sessionTransport: new CloudflareSessionTransport(environment.SESSION_RELAY),
            },
        });
        if (new URL(request.url).pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`) && cx.services.bots !== null) {
            return await botApplication.fetch(request, { services: { bots: cx.services.bots } });
        }
        return await application.fetch(request, cx);
    },
};

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
