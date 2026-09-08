import {
    type ChannelGateway,
    createMobiusApplication,
    type PairingGateway,
    type SessionQuotaPolicy,
} from "@moxt-ai/mobius-relay-core";

import { NodeSessionRuntime } from "./node-session-runtime.ts";

export interface NodeRelayOptions {
    readonly channelGateway: ChannelGateway;
    readonly contentRoot: string;
    readonly databasePath: string;
    readonly pairingGateway: PairingGateway;
    readonly quota?: SessionQuotaPolicy;
}

export interface NodeRelay {
    readonly close: () => void;
    readonly fetch: (request: Request) => Promise<Response>;
    readonly sessionRuntime: NodeSessionRuntime;
}

export function createNodeRelay(options: NodeRelayOptions): NodeRelay {
    const sessions = new NodeSessionRuntime(options.databasePath, options.contentRoot, options.quota);
    const app = createMobiusApplication({
        channelGateway: options.channelGateway,
        pairingGateway: options.pairingGateway,
        sessionCommands: sessions,
        sessionQueries: sessions,
        sessionTransfers: sessions,
        sessionArtifacts: sessions,
        sessionEventStreams: sessions,
    })
        .create()
        .resolve("application");
    return {
        close: sessions.close,
        fetch: async (request) => await app.fetch(request),
        sessionRuntime: sessions,
    };
}
