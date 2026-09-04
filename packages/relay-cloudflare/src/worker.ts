import { createRelayApp } from "@moxt-ai/mobius-relay-core";

import { CloudflareChannelRuntime } from "./cloudflare-channel-runtime.ts";
import { D1PairingDirectory } from "./d1-pairing-directory.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";

export interface RelayBindings {
  readonly DIRECTORY_DATABASE: D1Database;
  readonly RUNTIME_RELAY: DurableObjectNamespace;
}

const worker: ExportedHandler<RelayBindings> = {
  fetch: (request, environment) =>
    createRelayApp({
      channelRuntime: new CloudflareChannelRuntime(environment.RUNTIME_RELAY),
      pairingDirectory: new D1PairingDirectory(environment.DIRECTORY_DATABASE),
    }).fetch(request),
};

export { RuntimeRelay };
export default worker;
