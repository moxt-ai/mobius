import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import type {
    ChannelGateway,
    PairingGateway,
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "./gateway/index.ts";
import { ChannelService } from "./service/channel/channel-service.ts";
import { PairingService } from "./service/pairing/pairing-service.ts";
import type { PairingTenantResolver } from "./service/pairing/pairing-tenant-resolver.ts";
import { SessionService } from "./service/session/session-service.ts";

export interface RelayGateways {
    readonly channelGateway: ChannelGateway;
    readonly pairingGateway: PairingGateway;
    readonly pairingTenantResolver: PairingTenantResolver;
    readonly sessionCommands: SessionCommandGateway;
    readonly sessionQueries: SessionQueryGateway;
    readonly sessionTransfers: SessionTransferGateway;
    readonly sessionArtifacts: SessionArtifactGateway;
    readonly sessionEventStreams: SessionEventStreamGateway;
    readonly nowEpochMilliseconds: () => number;
}

export interface RelayInfrastructure {
    readonly gateways: RelayGateways;
    readonly config: { readonly apiPrefix: string };
    readonly logger: {
        readonly error: Console["error"];
        readonly info: Console["info"];
        readonly warn: Console["warn"];
    };
}

export type RelayContext = ReturnType<typeof createMobiusDependencies>;

export function createMobiusDependencies(infrastructure: RelayInfrastructure) {
    const config = Object.freeze({ apiPrefix: parseMobiusApiPrefix(infrastructure.config.apiPrefix) });
    const cx = { ...infrastructure, config };
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            channels: new ChannelService(cx),
            pairings: new PairingService(cx),
            sessions: new SessionService(cx),
        }),
    });
}

export type RelayDependencies = Omit<RelayGateways, "nowEpochMilliseconds">;

export function relayInfrastructure(gateways: RelayDependencies, apiPrefix = MOBIUS_API_PREFIX): RelayInfrastructure {
    return {
        config: { apiPrefix },
        gateways: { ...gateways, nowEpochMilliseconds: () => Date.now() },
        logger: console,
    };
}
