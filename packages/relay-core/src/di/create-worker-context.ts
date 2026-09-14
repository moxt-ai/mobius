import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import type { BotConnectionGateway } from "../gateway/bot-connection-gateway.ts";
import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import { D1DatabaseAdapter } from "../infra/d1-database.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
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
    readonly identityDatabases: readonly D1Database[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly quotaPolicy: SessionQuotaPolicyProvider;
    readonly gateways: WorkerRuntimeGateways;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        bots: { connections: options.gateways.connections },
        config: { apiPrefix: options.apiPrefix, quotaPolicy: options.quotaPolicy },
        databases: { resolve: (placement) => D1DatabaseAdapter.from(options.databases.resolve(placement)) },
        identityDatabases: options.identityDatabases.map(D1DatabaseAdapter.from),
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
