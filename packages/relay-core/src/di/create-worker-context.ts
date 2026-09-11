import type { SessionQuotaPolicyProvider } from "../entity/do/session.ts";
import { CloudflareBotConnectionRuntime } from "../gateway/cloudflare-bot-connection-runtime.ts";
import { CloudflareChannelRuntime } from "../gateway/cloudflare-channel-runtime.ts";
import { CloudflareSessionTransport } from "../gateway/cloudflare-session-transport.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import { D1DatabaseAdapter } from "../infra/d1-database.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { PublicProjectBootstrapAuthorizer } from "../service/pairing/pairing-request-service.ts";
import { createRelayDependencies } from "./create-relay-dependencies.ts";

export function createWorkerContext(options: {
    readonly namespaces: {
        readonly runtime: DurableObjectNamespace;
        readonly sessions: DurableObjectNamespace;
        readonly connections: DurableObjectNamespace;
    };
    readonly namespacePrefix: string;
    readonly authorization: ProjectAccessAuthorizer;
    readonly bootstrap: PublicProjectBootstrapAuthorizer;
    readonly databases: ProjectDatabaseBindings;
    readonly identityDatabases: readonly D1Database[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly quotaPolicy: SessionQuotaPolicyProvider;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        bots: { connections: new CloudflareBotConnectionRuntime(options.namespaces.connections) },
        config: { apiPrefix: options.apiPrefix, quotaPolicy: options.quotaPolicy },
        databases: { resolve: (placement) => D1DatabaseAdapter.from(options.databases.resolve(placement)) },
        identityDatabases: options.identityDatabases.map(D1DatabaseAdapter.from),
        projects: options.projects,
        logger: console,
        gateways: {
            channelGateway: new CloudflareChannelRuntime({ gateways: { runtimeRelay: options.namespaces.runtime } }),
            publicProjectBootstrap: options.bootstrap,
            sessionTransport: new CloudflareSessionTransport(options.namespaces.sessions, options.namespacePrefix),
            nowEpochMilliseconds: () => Date.now(),
        },
    });
}
