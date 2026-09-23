import { ProjectScope } from "../entity/do/session.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import { ChannelActor } from "../service/channel/channel-actor.ts";
import { ChannelCredentialService } from "../service/channel/channel-credential-service.ts";
import { RuntimeConnectionService } from "../service/channel/runtime-connection-service.ts";
import { type RuntimePeers, RuntimeService } from "../service/channel/runtime-service.ts";
import { ChannelCredentialStorage } from "../storage/channel-credential-storage.ts";
import { RuntimeConnectionStorage } from "../storage/runtime-connection-storage.ts";

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly storages: {
        readonly databaseResolver: DatabaseResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const credentialService = async (scope: ProjectScope, signal: AbortSignal) => {
        const project = await cx.storages.projectDirectory.resolve(scope.projectId, signal);
        signal.throwIfAborted();
        if (project.projectId !== scope.projectId) {
            throw new Error("The Project placement is invalid");
        }
        const database = cx.storages.databaseResolver.resolve(project.storagePlacement);
        return new ChannelCredentialService(new ChannelCredentialStorage(database));
    };
    const credentials: Pick<ChannelCredentialService, "isActive"> = {
        isActive: async (identity, signal) => {
            const scope = new ProjectScope(identity.projectId);
            return (await credentialService(scope, signal)).isActive(identity, signal);
        },
    };
    const services = {
        credentials,
        connections: new RuntimeConnectionService(new RuntimeConnectionStorage(cx.database)),
        channel: (runtimeId: string, _scope: ProjectScope) =>
            new ChannelActor({
                config: { runtimeId },
                gateways: { peers: cx.gateways.peers },
            }),
    };
    return {
        services: {
            credentials,
            connections: services.connections,
            runtime: new RuntimeService({
                services,
                gateways: cx.gateways,
                utilities: cx.utilities,
            }),
        },
        gateways: cx.gateways,
        storages: cx.storages,
        utilities: cx.utilities,
    };
}

export type DurableObjectContext = ReturnType<typeof createDurableObjectDependencies>;

export function createDurableObjectDependencies(cx: {
    readonly doDatabase: DoSqlDatabase;
    readonly storages: {
        readonly databaseResolver: DatabaseResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const runtime = createRuntimeRelayDependencies({
        database: cx.doDatabase,
        gateways: cx.gateways,
        storages: cx.storages,
        utilities: cx.utilities,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: cx.gateways,
        storages: cx.storages,
        utilities: cx.utilities,
        services: runtime.services,
        applications: {
            runtime: createRuntimeRoutes(runtime.services.runtime),
        },
    };
}
