import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    BotConnectionActor,
    CloudflareBotApi,
    CloudflareChannelRuntime,
    CloudflareSessionRuntime,
    D1PairingGateway,
    D1PairingIdentityDirectory,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import {
    ConfiguredPairingTenantResolver,
    createMobiusApplication,
    createMobiusDependencies,
} from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { LiteSessionRelay, SessionRelay } from "./session-relay.ts";
import { StandaloneTenantShardingDirectory } from "./tenant-sharding-directory.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly MOBIUS_TENANT_ID?: string;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const application = createMobiusApplication();
class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayBindings) {
        super(
            state,
            environment,
            new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
            new StandaloneTenantShardingDirectory(),
        );
    }
}

const worker: ExportedHandler<RelayBindings> = {
    fetch: async (request, environment) => {
        const infrastructure = {
            config: { quota: sessionQuotaFromEnvironment(environment) },
            gateways: {
                sessionRelay: environment.SESSION_RELAY,
                databaseResolver: new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
                tenantShardingDirectory: new StandaloneTenantShardingDirectory(),
                pairingIdentityDirectory: new D1PairingIdentityDirectory([environment.DIRECTORY_DATABASE]),
                runtimeRelay: environment.RUNTIME_RELAY,
            },
        };
        const sessions = new CloudflareSessionRuntime(infrastructure);
        const channelRuntime = new CloudflareChannelRuntime(infrastructure);
        const botApi = new CloudflareBotApi(environment, channelRuntime, sessions);
        if (botApi.handles(request)) {
            return await botApi.fetch(request);
        }
        const cx = createMobiusDependencies({
            config: { apiPrefix: MOBIUS_API_PREFIX },
            logger: console,
            gateways: {
                nowEpochMilliseconds: () => Date.now(),
                channelGateway: channelRuntime,
                pairingGateway: new D1PairingGateway(infrastructure),
                pairingTenantResolver: new ConfiguredPairingTenantResolver(environment.MOBIUS_TENANT_ID),
                sessionCommands: sessions,
                sessionQueries: sessions,
                sessionTransfers: sessions,
                sessionArtifacts: sessions,
                sessionEventStreams: sessions,
            },
        });
        return await application.fetch(request, cx);
    },
};

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
