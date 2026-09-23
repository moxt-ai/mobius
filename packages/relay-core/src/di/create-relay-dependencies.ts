import { parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { ChannelService } from "../service/channel/channel-service.ts";
import { RemoteSessionRuntime } from "../service/do/remote-session-runtime.ts";
import { SessionService } from "../service/do/session-service.ts";
import { PairingDirectoryService } from "../service/pairing/pairing-directory-service.ts";
import { PairingIdentityService } from "../service/pairing/pairing-identity-service.ts";
import { PairingService } from "../service/pairing/pairing-service.ts";
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
    readonly gateways: {
        readonly channelGateway: ChannelGateway;
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
            projectDirectory: cx.projects,
        },
        services: { identities, projectAuthentication: cx.authentication.projects },
    });
}

function createHttpContext(infrastructure: RelayInfrastructure, pairings: PairingDirectoryService) {
    const sessions = new RemoteSessionRuntime({
        storages: {
            directory: new SessionDirectoryStorage(infrastructure.databases),
            projects: infrastructure.projects,
        },
        config: { quotaPolicy: infrastructure.config.quotaPolicy },
        gateways: {
            transport: infrastructure.gateways.sessionTransport,
        },
    });
    const cx = {
        config: { apiPrefix: parseMobiusApiPrefix(infrastructure.config.apiPrefix) },
        logger: infrastructure.logger,
        services: { pairings },
        gateways: {
            ...infrastructure.gateways,
        },
        runtimes: {
            sessionCommands: sessions,
            sessionQueries: sessions,
            sessionTransfers: sessions,
            sessionEventStreams: sessions,
        },
    };
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            pairings,
            runtimePairings: new PairingService(cx),
            channels: new ChannelService(cx),
            sessions: new SessionService(cx),
        }),
    });
}

export type RelayContext = ReturnType<typeof createHttpContext>;

export function createRelayDependencies(infrastructure: RelayInfrastructure): RelayContext;
export function createRelayDependencies(infrastructure: RelayInfrastructure) {
    const pairings = createPairings(infrastructure);
    return createHttpContext(infrastructure, pairings);
}
