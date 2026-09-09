import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    ConfiguredPairingTenantResolver,
    createMobiusApplication,
    createMobiusDependencies,
} from "@moxt-ai/mobius-relay-core";

import { CloudflareBotApi } from "./bot-api.ts";
import { CloudflareChannelRuntime } from "./cloudflare-channel-runtime.ts";
import { CloudflareSessionRuntime } from "./cloudflare-session-runtime.ts";
import { D1PairingGateway } from "./d1-pairing-gateway.ts";
import { BotConnectionActor } from "./durable-objects/bot-connection-actor.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import { LiteSessionRelay, SessionRelay } from "./durable-objects/session-relay.ts";
import { type LiteSessionConfigurationEnvironment, sessionQuotaFromEnvironment } from "./session-configuration.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly MOBIUS_TENANT_ID?: string;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const application = createMobiusApplication();
const worker: ExportedHandler<RelayBindings> = {
    fetch: async (request, environment) => {
        const infrastructure = {
            config: { quota: sessionQuotaFromEnvironment(environment) },
            gateways: {
                sessionRelay: environment.SESSION_RELAY,
                directoryDatabase: environment.DIRECTORY_DATABASE,
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
