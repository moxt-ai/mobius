import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import type { BotConnectionGateway } from "../gateway/bot-connection-gateway.ts";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import type { PublicProjectBootstrapAuthorizer } from "../service/pairing/pairing-request-service.ts";
import { createRelayDependencies } from "./create-relay-dependencies.ts";

export interface WorkerRuntimeGateways {
    readonly channel: ChannelGateway;
    readonly sessions: SessionTransport;
    readonly connections: BotConnectionGateway;
}

export function createWorkerContext(options: {
    readonly authorization: ProjectAccessAuthorizer;
    readonly bootstrap: PublicProjectBootstrapAuthorizer;
    readonly databases: ProjectDatabaseBindings;
    readonly identityDatabases: readonly SqlDatabase[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly quotaPolicy: SessionQuotaPolicyProvider;
    readonly gateways: WorkerRuntimeGateways;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        bots: { connections: options.gateways.connections },
        config: { apiPrefix: options.apiPrefix, quotaPolicy: options.quotaPolicy },
        databases: options.databases,
        identityDatabases: options.identityDatabases,
        projects: options.projects,
        logger: console,
        gateways: {
            channelGateway: options.gateways.channel,
            publicProjectBootstrap: options.bootstrap,
            sessionTransport: options.gateways.sessions,
            nowEpochMilliseconds: () => Date.now(),
        },
    });
}
