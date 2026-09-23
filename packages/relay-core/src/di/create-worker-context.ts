import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { createRelayDependencies } from "./create-relay-dependencies.ts";

export interface WorkerRuntimeGateways {
    readonly channel: ChannelGateway;
}

export function createWorkerContext(options: {
    readonly authorization: ProjectAccessAuthorizer;
    readonly databases: ProjectDatabaseBindings;
    readonly identityDatabases: readonly SqlDatabase[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly gateways: WorkerRuntimeGateways;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        config: { apiPrefix: options.apiPrefix },
        databases: options.databases,
        identityDatabases: options.identityDatabases,
        projects: options.projects,
        logger: console,
        gateways: {
            channelGateway: options.gateways.channel,
            nowEpochMilliseconds: () => Date.now(),
        },
    });
}
