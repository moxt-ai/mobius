import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { createMobiusApplication, createMobiusDependencies } from "@moxt-ai/mobius-relay-core";

import { CloudflareChannelRuntime } from "./cloudflare-channel-runtime.ts";
import { CloudflareSessionRuntime } from "./cloudflare-session-runtime.ts";
import { D1PairingGateway } from "./d1-pairing-gateway.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import { LiteSessionRelay, SessionRelay } from "./durable-objects/session-relay.ts";
import { type LiteSessionConfigurationEnvironment, sessionQuotaFromEnvironment } from "./session-configuration.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const application = createMobiusApplication();
const worker: ExportedHandler<RelayBindings> = {
    fetch: (request, environment) => {
        const infrastructure = {
            config: { quota: sessionQuotaFromEnvironment(environment) },
            gateways: {
                sessionRelay: environment.SESSION_RELAY,
                directoryDatabase: environment.DIRECTORY_DATABASE,
                runtimeRelay: environment.RUNTIME_RELAY,
            },
        };
        const sessions = new CloudflareSessionRuntime(infrastructure);
        const cx = createMobiusDependencies({
            config: { apiPrefix: MOBIUS_API_PREFIX },
            logger: console,
            gateways: {
                nowEpochMilliseconds: () => Date.now(),
                channelGateway: new CloudflareChannelRuntime(infrastructure),
                pairingGateway: new D1PairingGateway(infrastructure),
                sessionCommands: sessions,
                sessionQueries: sessions,
                sessionTransfers: sessions,
                sessionArtifacts: sessions,
                sessionEventStreams: sessions,
            },
        });
        return application.fetch(request, cx);
    },
};

export { LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
