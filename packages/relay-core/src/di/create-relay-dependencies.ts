import { parseMobiusApiPrefix } from "@moxt-ai/mobius-sdk/protocol";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { ProjectApplicationResolver } from "../infra/project-application-resolver.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStore, ProjectStoreResolver } from "../infra/project-store.ts";
import { ChannelService } from "../service/channel/channel-service.ts";
import type { LocalSessionOperations } from "../service/channel/local-session-operations.ts";
import { PairingDirectoryService } from "../service/pairing/pairing-directory-service.ts";
import { PairingIdentityService } from "../service/pairing/pairing-identity-service.ts";
import { PairingService } from "../service/pairing/pairing-service.ts";

interface PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly projectApplications: ProjectApplicationResolver;
    readonly stores: ProjectStoreResolver;
    readonly projects: ProjectStorageDirectory;
    /** The Project stores this execution searches to find the Project a credential belongs to. */
    readonly identityStores: readonly ProjectStore[];
}

export interface RelayInfrastructure extends PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly gateways: {
        readonly channelGateway: ChannelGateway;
        readonly runtimeOperations?: LocalSessionOperations;
        readonly nowEpochMilliseconds: () => number;
    };
    readonly config: { readonly apiPrefix: string };
    readonly logger: {
        readonly error: Console["error"];
        readonly info: Console["info"];
        readonly warn: Console["warn"];
    };
}

function createPairings(cx: PairingInfrastructure) {
    const identities = new PairingIdentityService(cx.identityStores, cx.stores, cx.projects);
    return new PairingDirectoryService({
        gateways: { projectApplications: cx.projectApplications },
        storages: {
            forProject: (project) => cx.stores.resolve(project.storagePlacement),
            projectDirectory: cx.projects,
        },
        services: { identities, projectAuthentication: cx.authentication.projects },
    });
}

function createHttpContext(infrastructure: RelayInfrastructure, pairings: PairingDirectoryService) {
    const cx = {
        config: { apiPrefix: parseMobiusApiPrefix(infrastructure.config.apiPrefix) },
        logger: infrastructure.logger,
        services: { pairings },
        gateways: {
            ...infrastructure.gateways,
        },
    };
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            pairings,
            runtimePairings: new PairingService(cx),
            channels: new ChannelService(cx),
        }),
    });
}

export type RelayContext = ReturnType<typeof createHttpContext>;

export function createRelayDependencies(infrastructure: RelayInfrastructure): RelayContext;
export function createRelayDependencies(infrastructure: RelayInfrastructure) {
    const pairings = createPairings(infrastructure);
    return createHttpContext(infrastructure, pairings);
}
