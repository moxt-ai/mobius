import { parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import type { ProjectAccessAuthorizer } from "../entity/authentication/project-authentication.ts";
import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import type { BotConnectionGateway } from "../gateway/bot-connection-gateway.ts";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import type { TenantShardingDirectory } from "../infra/tenant-sharding-directory.ts";
import { BotAuthorization } from "../service/bot/bot-authorization.ts";
import { BotConversationService } from "../service/bot/bot-conversation-service.ts";
import { BotManagementService } from "../service/bot/bot-management-service.ts";
import { BotService } from "../service/bot/bot-service.ts";
import { BotTargetService } from "../service/bot/bot-target-service.ts";
import { RemoteBotSessionRuntime } from "../service/bot/remote-bot-session-runtime.ts";
import { ChannelService } from "../service/channel/channel-service.ts";
import { RemoteSessionRuntime } from "../service/do/remote-session-runtime.ts";
import { SessionService } from "../service/do/session-service.ts";
import { PairingDirectoryService } from "../service/pairing/pairing-directory-service.ts";
import { PairingIdentityService } from "../service/pairing/pairing-identity-service.ts";
import type { PublicProjectBootstrapAuthorizer } from "../service/pairing/pairing-request-service.ts";
import { PairingRequestService } from "../service/pairing/pairing-request-service.ts";
import { PairingService } from "../service/pairing/pairing-service.ts";
import type { PairingTenantResolver } from "../service/pairing/pairing-tenant-resolver.ts";
import { BotConnectionStorage } from "../storage/bot-connection-storage.ts";
import { BotControlStorage } from "../storage/bot-control-storage.ts";
import { BotConversationStorage } from "../storage/bot-conversation-storage.ts";
import { BotCredentialStorage } from "../storage/bot-credential-storage.ts";
import { PairingIdentityStorage } from "../storage/pairing-identity-storage.ts";
import { PairingStorage } from "../storage/pairing-storage.ts";
import { SessionDirectoryStorage } from "../storage/session-directory-storage.ts";

interface PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly databases: DatabaseResolver;
    readonly tenants: TenantShardingDirectory;
    readonly identityDatabases: readonly SqlDatabase[];
}

export interface RelayInfrastructure extends PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly bots: {
        readonly connections: BotConnectionGateway;
    } | null;
    readonly gateways: {
        readonly channelGateway: ChannelGateway;
        readonly pairingTenantResolver: PairingTenantResolver;
        readonly publicProjectBootstrap: PublicProjectBootstrapAuthorizer;
        readonly sessionTransport: SessionTransport;
        readonly nowEpochMilliseconds: () => number;
    };
    readonly config: { readonly apiPrefix: string; readonly quotaPolicy: SessionQuotaPolicyProvider };
    readonly logger: {
        readonly error: Console["error"];
        readonly info: Console["info"];
        readonly warn: Console["warn"];
    };
}

function createPairings(cx: PairingInfrastructure) {
    const sources = cx.identityDatabases.map((database, index) => ({ sourceId: String(index), database }));
    const identities = new PairingIdentityService(new PairingIdentityStorage(sources, cx.databases), cx.tenants);
    return new PairingDirectoryService({
        storages: {
            forTenant: (tenant) => new PairingStorage(tenant, cx.databases),
        },
        services: { identities, projectAuthentication: cx.authentication.projects },
        gateways: {
            tenantShardingDirectory: cx.tenants,
        },
    });
}

function createHttpContext(infrastructure: RelayInfrastructure, pairings: PairingDirectoryService) {
    const sessions = new RemoteSessionRuntime({
        storages: { directory: new SessionDirectoryStorage(infrastructure.databases) },
        config: { quotaPolicy: infrastructure.config.quotaPolicy },
        gateways: {
            transport: infrastructure.gateways.sessionTransport,
            databaseResolver: infrastructure.databases,
            tenantShardingDirectory: infrastructure.tenants,
        },
    });
    const cx = {
        config: { apiPrefix: parseMobiusApiPrefix(infrastructure.config.apiPrefix) },
        logger: infrastructure.logger,
        services: { pairings },
        gateways: {
            ...infrastructure.gateways,
            sessionCommands: sessions,
            sessionQueries: sessions,
            sessionTransfers: sessions,
            sessionArtifacts: sessions,
            sessionEventStreams: sessions,
        },
    };
    const bots = infrastructure.bots === null ? null : createBots(infrastructure.bots, infrastructure, sessions);
    const pairingRequests = new PairingRequestService(
        pairings,
        infrastructure.gateways.pairingTenantResolver,
        infrastructure.gateways.publicProjectBootstrap,
    );
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            bots,
            pairings,
            createPairing: pairingRequests.createPairing,
            runtimePairings: new PairingService(cx),
            channels: new ChannelService(cx),
            sessions: new SessionService(cx),
        }),
    });
}

function createBots(
    infrastructure: NonNullable<RelayInfrastructure["bots"]>,
    cx: RelayInfrastructure,
    sessions: RemoteSessionRuntime,
) {
    return new BotService({
        forTenant: (tenant) => {
            const storages = {
                connections: new BotConnectionStorage(tenant, cx.databases),
                control: new BotControlStorage(tenant, cx.databases),
                conversations: new BotConversationStorage(tenant, cx.databases),
            };
            return {
                storages,
                services: {
                    targets: new BotTargetService(storages.connections),
                    conversations: new BotConversationService(storages.conversations),
                    management: new BotManagementService(
                        storages.control,
                        storages.connections,
                        storages.conversations,
                    ),
                },
            };
        },
        services: {
            authorization: new BotAuthorization(
                [...new Set(cx.identityDatabases)].map((database) => new BotCredentialStorage(database)),
                cx.authentication.projects,
            ),
        },
        gateways: {
            tenants: cx.tenants,
            tenantResolver: cx.gateways.pairingTenantResolver,
            channels: cx.gateways.channelGateway,
            connections: infrastructure.connections,
            sessions,
            botSessions: new RemoteBotSessionRuntime(cx.gateways.sessionTransport, sessions),
        },
    });
}

export type RelayContext = ReturnType<typeof createHttpContext>;

export function createRelayDependencies(infrastructure: RelayInfrastructure): RelayContext;
export function createRelayDependencies(infrastructure: PairingInfrastructure): {
    readonly services: { readonly pairings: PairingDirectoryService };
};
export function createRelayDependencies(infrastructure: PairingInfrastructure | RelayInfrastructure) {
    const pairings = createPairings(infrastructure);
    if ("gateways" in infrastructure) {
        return createHttpContext(infrastructure, pairings);
    }
    return { services: { pairings } };
}
