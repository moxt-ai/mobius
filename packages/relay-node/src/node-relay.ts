import {
  type ChannelRuntime,
  createRelayApp,
  type PairingDirectory,
  type SessionQuotaPolicy,
} from "@moxt-ai/mobius-relay-core";

import { NodeSessionRuntime } from "./node-session-runtime.ts";

export interface NodeRelayOptions {
  readonly channelRuntime: ChannelRuntime;
  readonly contentRoot: string;
  readonly databasePath: string;
  readonly pairingDirectory: PairingDirectory;
  readonly quota?: SessionQuotaPolicy;
}

export interface NodeRelay {
  readonly close: () => void;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly sessionRuntime: NodeSessionRuntime;
}

export function createNodeRelay(options: NodeRelayOptions): NodeRelay {
  const sessionRuntime = new NodeSessionRuntime(
    options.databasePath,
    options.contentRoot,
    options.quota,
  );
  const app = createRelayApp({
    channelRuntime: options.channelRuntime,
    pairingDirectory: options.pairingDirectory,
    sessionRuntime,
  });
  return {
    close: sessionRuntime.close,
    fetch: async (request) => await app.fetch(request),
    sessionRuntime,
  };
}
