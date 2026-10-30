import { ProjectScope } from "../entity/do/session.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStoreResolver } from "../infra/project-store.ts";
import { DisabledSessionRecording, type SessionRecording } from "../infra/session-recording.ts";
import type { SessionStatusNotifications } from "../infra/session-status-notifications.ts";
import { BestEffortRecording } from "../service/channel/best-effort-recording.ts";
import { ChannelActor } from "../service/channel/channel-actor.ts";
import { ChannelCredentialService } from "../service/channel/channel-credential-service.ts";
import { LocalRuntimeRequests } from "../service/channel/local-runtime-requests.ts";
import { NativeSessionForks } from "../service/channel/native-session-forks.ts";
import { RuntimeConnectionService } from "../service/channel/runtime-connection-service.ts";
import { type RuntimePeers, RuntimeService } from "../service/channel/runtime-service.ts";
import { NativeSessionForkStorage } from "../storage/native-session-fork-storage.ts";
import { RuntimeConnectionStorage } from "../storage/runtime-connection-storage.ts";

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly storages: {
        readonly projectStores: ProjectStoreResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly recording: SessionRecording;
        readonly notifications?: SessionStatusNotifications;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    /** Null when the Project is no longer served: none of its credentials remain active. */
    const credentialService = async (scope: ProjectScope, signal: AbortSignal) => {
        const project = await cx.storages.projectDirectory.resolve(scope.projectId, signal);
        signal.throwIfAborted();
        if (project === null) {
            return null;
        }
        if (project.projectId !== scope.projectId) {
            throw new Error("The Project placement is invalid");
        }
        return new ChannelCredentialService(cx.storages.projectStores.resolve(project.storagePlacement));
    };
    const credentials: Pick<ChannelCredentialService, "isActive" | "isRuntimeActive"> = {
        isActive: async (identity, signal) => {
            const service = await credentialService(new ProjectScope(identity.projectId), signal);
            return service !== null && (await service.isActive(identity, signal));
        },
        isRuntimeActive: async (identity, signal) => {
            const service = await credentialService(new ProjectScope(identity.projectId), signal);
            return service !== null && (await service.isRuntimeActive(identity, signal));
        },
    };
    const recording = new BestEffortRecording(cx.gateways.recording, cx.utilities.waitUntil);
    const services = {
        credentials,
        connections: new RuntimeConnectionService(new RuntimeConnectionStorage(cx.database)),
        channel: (runtimeId: string, scope: ProjectScope) =>
            new ChannelActor({
                config: { projectId: scope.projectId, runtimeId },
                gateways: {
                    peers: cx.gateways.peers,
                    recording,
                    ...(cx.gateways.notifications === undefined ? {} : { notifications: cx.gateways.notifications }),
                },
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
        readonly projectStores: ProjectStoreResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly recording?: SessionRecording;
        readonly notifications?: SessionStatusNotifications;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const requests = new LocalRuntimeRequests();
    const source = cx.gateways.peers;
    const peers: RuntimePeers = {
        accept: source.accept,
        sockets: source.sockets,
        daemonConnections: source.daemonConnections,
        daemons: source.daemons,
        hosts: source.hosts,
        nativeRequests: source.nativeRequests,
        viewers: source.viewers,
        historyRecipients: () => [...source.historyRecipients(), ...requests.routes().map(({ socket }) => socket)],
        operations: () => [...source.operations(), ...requests.routes()],
    };
    const runtime = createRuntimeRelayDependencies({
        database: cx.doDatabase,
        gateways: {
            peers,
            recording: cx.gateways.recording ?? new DisabledSessionRecording(),
            ...(cx.gateways.notifications === undefined ? {} : { notifications: cx.gateways.notifications }),
        },
        storages: cx.storages,
        utilities: cx.utilities,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: { ...cx.gateways, peers, requests },
        storages: cx.storages,
        utilities: cx.utilities,
        services: {
            ...runtime.services,
            nativeForks: new NativeSessionForks(new NativeSessionForkStorage(cx.doDatabase), cx.utilities.waitUntil),
        },
        applications: {
            runtime: createRuntimeRoutes(runtime.services.runtime),
        },
    };
}
