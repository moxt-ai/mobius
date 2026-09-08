import { createRelayApp } from "@moxt-ai/mobius-relay-core";

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

const worker: ExportedHandler<RelayBindings> = {
    fetch: (request, environment) => {
        const sessions = new CloudflareSessionRuntime(
            environment.SESSION_RELAY,
            environment.DIRECTORY_DATABASE,
            sessionQuotaFromEnvironment(environment),
        );
        return createRelayApp({
            channelGateway: new CloudflareChannelRuntime(environment.RUNTIME_RELAY),
            pairingGateway: new D1PairingGateway(environment.DIRECTORY_DATABASE),
            sessionCommands: sessions,
            sessionQueries: sessions,
            sessionTransfers: sessions,
            sessionArtifacts: sessions,
            sessionEventStreams: sessions,
        }).fetch(request);
    },
};

export { LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
