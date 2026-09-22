import {
    DEFAULT_SESSION_QUOTA_POLICY,
    ProjectScope,
    type SessionQuotaPolicy,
    StaticSessionQuotaPolicyProvider,
} from "../entity/do/session.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import { createDoRoutes } from "../http/do/do-routes.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { ContentPersistence, ImmutableContentStore } from "../infra/content-store.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { SessionCommandRuntime, SessionQueryRuntime } from "../infra/session-runtime.ts";
import { ChannelActor } from "../service/channel/channel-actor.ts";
import { ChannelCredentialService } from "../service/channel/channel-credential-service.ts";
import { RuntimeConnectionService } from "../service/channel/runtime-connection-service.ts";
import { type RuntimePeers, RuntimeService } from "../service/channel/runtime-service.ts";
import { ContentService } from "../service/do/content-service.ts";
import { DoService } from "../service/do/do-service.ts";
import { RemoteSessionRuntime } from "../service/do/remote-session-runtime.ts";
import { SessionArchiveService } from "../service/do/session-archive-service.ts";
import { SessionArtifactService } from "../service/do/session-artifact-service.ts";
import { SessionCommandService } from "../service/do/session-command-service.ts";
import { SessionEventProjector } from "../service/do/session-event-projector.ts";
import { SessionEventStreams } from "../service/do/session-event-stream.ts";
import { SessionInteractionService } from "../service/do/session-interaction-service.ts";
import { SessionLifecycleService } from "../service/do/session-lifecycle-service.ts";
import { SessionQueryService } from "../service/do/session-query-service.ts";
import { SessionRecoveryService } from "../service/do/session-recovery-service.ts";
import { SessionRetentionService } from "../service/do/session-retention-service.ts";
import { SessionStateService } from "../service/do/session-state-service.ts";
import { SessionTransferService } from "../service/do/session-transfer-service.ts";
import { SqliteSessionRuntime } from "../service/do/sqlite-session-runtime.ts";
import { ChannelCredentialStorage } from "../storage/channel-credential-storage.ts";
import { SessionArchiveStorage } from "../storage/do/session-archive-storage.ts";
import { SessionArtifactStorage } from "../storage/do/session-artifact-storage.ts";
import { SessionCommandsStorage } from "../storage/do/session-commands-storage.ts";
import { SessionDeletionStorage } from "../storage/do/session-deletion-storage.ts";
import { SessionEventProjectorStorage } from "../storage/do/session-event-projector-storage.ts";
import { SessionInteractionsStorage } from "../storage/do/session-interactions-storage.ts";
import { SessionLifecycleStorage } from "../storage/do/session-lifecycle-storage.ts";
import { SessionQueriesStorage } from "../storage/do/session-queries-storage.ts";
import { SessionRecoveryStorage } from "../storage/do/session-recovery-storage.ts";
import { SessionRetentionStorage } from "../storage/do/session-retention-storage.ts";
import { SessionStateStorage } from "../storage/do/session-state-storage.ts";
import { SessionTransferStorage } from "../storage/do/session-transfer-storage.ts";
import { SqliteContentStore } from "../storage/do/sqlite-content-store.ts";
import { initializeSessionSchema } from "../storage/do/sqlite-session-schema.ts";
import { RuntimeConnectionStorage } from "../storage/runtime-connection-storage.ts";
import { SessionDirectoryStorage } from "../storage/session-directory-storage.ts";

export type SessionContentConfiguration =
    | { readonly kind: "sqlite"; readonly archiveByteLimit: number }
    | { readonly kind: "external"; readonly content: ContentPersistence };

interface DoInfrastructure {
    readonly doDatabase: DoSqlDatabase;
    readonly storages: { readonly content: ImmutableContentStore };
    readonly config: { readonly quota?: SessionQuotaPolicy };
    readonly initializeSessionSchema: (database: DoSqlDatabase) => void;
}

function createDoContext(infrastructure: DoInfrastructure) {
    infrastructure.initializeSessionSchema(infrastructure.doDatabase);
    const archiveStorage = new SessionArchiveStorage(infrastructure);
    const eventProjectorStorage = new SessionEventProjectorStorage(infrastructure);
    const storages = Object.freeze({
        ...infrastructure.storages,
        recovery: new SessionRecoveryStorage(infrastructure.doDatabase),
        archive: archiveStorage,
        artifacts: new SessionArtifactStorage(infrastructure),
        commands: new SessionCommandsStorage({
            ...infrastructure,
            storages: { archive: archiveStorage, eventProjector: eventProjectorStorage },
        }),
        deletions: new SessionDeletionStorage(infrastructure),
        eventProjector: eventProjectorStorage,
        interactions: new SessionInteractionsStorage(infrastructure),
        lifecycle: new SessionLifecycleStorage(infrastructure),
        queries: new SessionQueriesStorage(infrastructure),
        state: new SessionStateStorage(infrastructure),
        transfers: new SessionTransferStorage({ ...infrastructure, storages: { archive: archiveStorage } }),
    });
    const config = Object.freeze({ quota: infrastructure.config.quota ?? DEFAULT_SESSION_QUOTA_POLICY });
    const cx = { ...infrastructure, config, storages };
    const archive = new SessionArchiveService(cx);
    const eventProjector = new SessionEventProjector(cx);
    const state = new SessionStateService(cx);
    const artifacts = new SessionArtifactService({ ...cx, services: { state } });
    const lifecycle = new SessionLifecycleService({ ...cx, services: { archive, state } });
    const queries = new SessionQueryService({ ...cx, services: { archive, state } });
    const eventStreams = new SessionEventStreams({ runtimes: { queries } });
    const interactions = new SessionInteractionService({ ...cx, services: { queries, state } });
    const commands = new SessionCommandService({ ...cx, services: { archive, eventProjector, lifecycle, state } });
    const transfers = new SessionTransferService({ ...cx, services: { archive, artifacts, state } });
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            archive,
            eventProjector,
            state,
            artifacts,
            lifecycle,
            queries,
            eventStreams,
            interactions,
            commands,
            transfers,
        }),
    });
}

function createSessionRuntime(cx: {
    readonly database: DoSqlDatabase;
    readonly quota: SessionQuotaPolicy;
    readonly content: SessionContentConfiguration;
    readonly initializeSessionSchema: (database: DoSqlDatabase) => void;
}) {
    const content =
        cx.content.kind === "sqlite"
            ? new ContentService(new SqliteContentStore(cx.database), cx.content.archiveByteLimit)
            : new ContentService(cx.content.content, null);
    return new SqliteSessionRuntime(
        createDoContext({
            doDatabase: cx.database,
            storages: { content },
            config: { quota: cx.quota },
            initializeSessionSchema: cx.initializeSessionSchema,
        }),
    );
}

function createSessionRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly content: SessionContentConfiguration;
    readonly quota: SessionQuotaPolicy;
    readonly initializeSessionSchema: (database: DoSqlDatabase) => void;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}) {
    const runtime = createSessionRuntime(cx);
    const recovery = new SessionRecoveryService({ ...cx, runtime });
    const operations = new DoService({ services: { runtime, recovery } });
    const retention = new SessionRetentionService(new SessionRetentionStorage(cx.database));
    return { application: createDoRoutes(runtime, operations), services: { recovery, operations, retention } };
}

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly storages: {
        readonly databaseResolver: DatabaseResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly runtimes: {
        readonly sessions: SessionCommandRuntime &
            SessionQueryRuntime &
            Pick<RemoteSessionRuntime, "disconnectSessions">;
    };
    readonly utilities: {
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
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
        channel: (runtimeId: string, scope: ProjectScope) =>
            new ChannelActor({
                config: { runtimeId, scope },
                connections: services.connections,
                gateways: { peers: cx.gateways.peers },
                runtimes: { commands: cx.runtimes.sessions, queries: cx.runtimes.sessions },
            }),
    };
    return {
        services: {
            credentials,
            connections: services.connections,
            runtime: new RuntimeService({
                services,
                gateways: cx.gateways,
                runtimes: cx.runtimes,
                utilities: cx.utilities,
            }),
        },
        gateways: cx.gateways,
        runtimes: cx.runtimes,
        storages: cx.storages,
        utilities: cx.utilities,
    };
}

export type DurableObjectContext = ReturnType<typeof createDurableObjectDependencies>;

export function createDurableObjectDependencies(cx: {
    readonly doDatabase: DoSqlDatabase;
    readonly content: SessionContentConfiguration;
    readonly quota: SessionQuotaPolicy;
    readonly initializeSessionSchema?: (database: DoSqlDatabase) => void;
    readonly storages: {
        readonly databaseResolver: DatabaseResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly sessionTransport: SessionTransport;
    };
    readonly utilities: {
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const sessions = new RemoteSessionRuntime({
        storages: {
            directory: new SessionDirectoryStorage(cx.storages.databaseResolver),
            projects: cx.storages.projectDirectory,
        },
        config: { quotaPolicy: new StaticSessionQuotaPolicyProvider(cx.quota) },
        gateways: {
            transport: cx.gateways.sessionTransport,
        },
    });
    const runtimes = { sessions };
    const runtime = createRuntimeRelayDependencies({
        database: cx.doDatabase,
        gateways: cx.gateways,
        runtimes,
        storages: cx.storages,
        utilities: cx.utilities,
    });
    const session = createSessionRelayDependencies({
        database: cx.doDatabase,
        content: cx.content,
        initializeSessionSchema: cx.initializeSessionSchema ?? initializeSessionSchema,
        quota: cx.quota,
        schedule: cx.utilities.schedule,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: cx.gateways,
        runtimes,
        storages: cx.storages,
        utilities: cx.utilities,
        services: {
            ...runtime.services,
            sessionRecovery: session.services.recovery,
            sessionRetention: session.services.retention,
            operations: session.services.operations,
        },
        applications: {
            runtime: createRuntimeRoutes(runtime.services.runtime),
            session: session.application,
        },
    };
}
