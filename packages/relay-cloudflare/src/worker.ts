import { createRelayApp } from "@moxt-ai/mobius-relay-core";

import { CloudflareChannelRuntime } from "./cloudflare-channel-runtime.ts";
import { CloudflareSessionRuntime } from "./cloudflare-session-runtime.ts";
import { D1PairingDirectory } from "./d1-pairing-directory.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import { SessionRelay } from "./durable-objects/session-relay.ts";
import {
  type SessionConfigurationEnvironment,
  sessionQuotaFromEnvironment,
} from "./session-configuration.ts";

export interface RelayBindings extends SessionConfigurationEnvironment {
  readonly DIRECTORY_DATABASE: D1Database;
  readonly RUNTIME_RELAY: DurableObjectNamespace;
  readonly SESSION_ARCHIVES: R2Bucket;
  readonly SESSION_RELAY: DurableObjectNamespace;
}

const worker: ExportedHandler<RelayBindings> = {
  fetch: (request, environment) =>
    createRelayApp({
      channelRuntime: new CloudflareChannelRuntime(environment.RUNTIME_RELAY),
      pairingDirectory: new D1PairingDirectory(environment.DIRECTORY_DATABASE),
      sessionRuntime: new CloudflareSessionRuntime(
        environment.SESSION_RELAY,
        environment.DIRECTORY_DATABASE,
        sessionQuotaFromEnvironment(environment),
      ),
    }).fetch(request),
};

export { RuntimeRelay, SessionRelay };
export default worker;
