import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { ProjectApplicationResolver } from "../infra/project-application-resolver.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStore, ProjectStoreResolver } from "../infra/project-store.ts";
import type { LocalSessionOperations } from "../service/channel/local-session-operations.ts";
import { createRelayDependencies } from "./create-relay-dependencies.ts";

export interface WorkerRuntimeGateways {
    readonly channel: ChannelGateway;
    readonly runtimeOperations?: LocalSessionOperations;
}

export function createWorkerContext(options: {
    readonly applications: ProjectApplicationResolver;
    readonly authorization: ProjectAccessAuthorizer;
    readonly stores: ProjectStoreResolver;
    readonly identityStores: readonly ProjectStore[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly gateways: WorkerRuntimeGateways;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        config: { apiPrefix: options.apiPrefix },
        stores: options.stores,
        identityStores: options.identityStores,
        projectApplications: options.applications,
        projects: options.projects,
        logger: console,
        gateways: {
            channelGateway: options.gateways.channel,
            ...(options.gateways.runtimeOperations === undefined
                ? {}
                : { runtimeOperations: options.gateways.runtimeOperations }),
            nowEpochMilliseconds: () => Date.now(),
        },
    });
}
