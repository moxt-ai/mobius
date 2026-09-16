import { parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { BotApiError } from "../entity/bot/bot-error.ts";
import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import type { BotConnectionGateway } from "../gateway/bot-connection-gateway.ts";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
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
    readonly projects: ProjectStorageDirectory;
    readonly identityDatabases: readonly SqlDatabase[];
}

export interface RelayInfrastructure extends PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly bots: {
        readonly connections: BotConnectionGateway;
    } | null;
    readonly gateways: {
        readonly channelGateway: ChannelGateway;
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
    const identities = new PairingIdentityService(new PairingIdentityStorage(sources, cx.databases), cx.projects);
    return new PairingDirectoryService({
        storages: {
            forProject: (project) => new PairingStorage(project, cx.databases),
        },
        services: { identities, projectAuthentication: cx.authentication.projects },
        gateways: {
            projectStorageDirectory: cx.projects,
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
            projectStorageDirectory: infrastructure.projects,
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
    const bots =
        infrastructure.bots === null ? null : createBots(infrastructure.bots, infrastructure, sessions, pairings);
    const pairingRequests = new PairingRequestService(pairings, infrastructure.gateways.publicProjectBootstrap);
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
    pairings: PairingDirectoryService,
) {
    return new BotService({
        forProject: (project) => {
            const storages = {
                connections: new BotConnectionStorage(project, cx.databases),
                control: new BotControlStorage(project, cx.databases),
                conversations: new BotConversationStorage(project, cx.databases),
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
                async (scope, signal) => {
                    const project = await cx.projects.resolve(scope.projectId, signal);
                    signal.throwIfAborted();
                    if (project.projectId !== scope.projectId) {
                        throw new BotApiError(
                            "bot_service_unavailable",
                            "The Project placement is invalid",
                            "unavailable",
                        );
                    }
                    return new BotCredentialStorage(cx.databases.resolve(project.storagePlacement));
                },
            ),
            controls: {
                close: pairings.closeControlHost,
                open: pairings.openProjectScopeControlHost,
            },
        },
        gateways: {
            projects: cx.projects,
            channels: cx.gateways.channelGateway,
            connections: infrastructure.connections,
            sessions,
            botSessions: new RemoteBotSessionRuntime(cx.gateways.sessionTransport, sessions, sessions),
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
