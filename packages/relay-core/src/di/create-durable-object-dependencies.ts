import type { BotSessionRuntime } from "../entity/bot/bot-session.ts";
import {
    DEFAULT_SESSION_QUOTA_POLICY,
    ProjectScope,
    type SessionQuotaPolicy,
    StaticSessionQuotaPolicyProvider,
} from "../entity/do/session.ts";
import type { BotConnectionGateway } from "../gateway/bot-connection-gateway.ts";
import type { SessionCommandGateway, SessionQueryGateway } from "../gateway/index.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import { createBotDeliveryRoutes } from "../http/bot/bot-delivery-routes.ts";
import { createDoRoutes } from "../http/do/do-routes.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { ContentPersistence, ImmutableContentStore } from "../infra/content-store.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import { BotConversationService } from "../service/bot/bot-conversation-service.ts";
import { BotDeliveryService } from "../service/bot/bot-delivery-service.ts";
import { BotRuntimeService } from "../service/bot/bot-runtime-service.ts";
import { BotTargetService } from "../service/bot/bot-target-service.ts";
import { RemoteBotSessionRuntime } from "../service/bot/remote-bot-session-runtime.ts";
import { ChannelActor } from "../service/channel/channel-actor.ts";
import { ChannelCredentialService } from "../service/channel/channel-credential-service.ts";
import { RuntimeConnectionService } from "../service/channel/runtime-connection-service.ts";
import { RuntimeRecoveryService } from "../service/channel/runtime-recovery-service.ts";
import { type RuntimePeers, RuntimeService } from "../service/channel/runtime-service.ts";
import { BotSessionService } from "../service/do/bot-session-service.ts";
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
import { SessionStateService } from "../service/do/session-state-service.ts";
import { SessionTransferService } from "../service/do/session-transfer-service.ts";
import { SqliteSessionRuntime } from "../service/do/sqlite-session-runtime.ts";
import { BotConnectionStorage } from "../storage/bot-connection-storage.ts";
import { BotControlStorage } from "../storage/bot-control-storage.ts";
import { BotConversationStorage } from "../storage/bot-conversation-storage.ts";
import { BotDeliveryStorage } from "../storage/bot-delivery-storage.ts";
import { ChannelCredentialStorage } from "../storage/channel-credential-storage.ts";
import { BotSessionStorage } from "../storage/do/bot-session-storage.ts";
import { SessionArchiveStorage } from "../storage/do/session-archive-storage.ts";
import { SessionArtifactStorage } from "../storage/do/session-artifact-storage.ts";
import { SessionCommandsStorage } from "../storage/do/session-commands-storage.ts";
import { SessionDeletionStorage } from "../storage/do/session-deletion-storage.ts";
import { SessionEventProjectorStorage } from "../storage/do/session-event-projector-storage.ts";
import { SessionInteractionsStorage } from "../storage/do/session-interactions-storage.ts";
import { SessionLifecycleStorage } from "../storage/do/session-lifecycle-storage.ts";
import { SessionQueriesStorage } from "../storage/do/session-queries-storage.ts";
import { SessionRecoveryStorage } from "../storage/do/session-recovery-storage.ts";
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
    readonly gateways: { readonly content: ImmutableContentStore };
    readonly config: { readonly quota?: SessionQuotaPolicy };
}

function createDoContext(infrastructure: DoInfrastructure) {
    initializeSessionSchema(infrastructure.doDatabase);
    const archiveStorage = new SessionArchiveStorage(infrastructure);
    const eventProjectorStorage = new SessionEventProjectorStorage(infrastructure);
    const storages = Object.freeze({
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
    const eventStreams = new SessionEventStreams({ gateways: { queries } });
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
}) {
    const content =
        cx.content.kind === "sqlite"
            ? new ContentService(new SqliteContentStore(cx.database), cx.content.archiveByteLimit)
            : new ContentService(cx.content.content, null);
    return new SqliteSessionRuntime(
        createDoContext({ doDatabase: cx.database, gateways: { content }, config: { quota: cx.quota } }),
    );
}

function createSessionRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly content: SessionContentConfiguration;
    readonly quota: SessionQuotaPolicy;
    readonly databases: DatabaseResolver;
    readonly projects: ProjectStorageDirectory;
    readonly connections: BotConnectionGateway;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}) {
    const runtime = createSessionRuntime(cx);
    const bots = new BotSessionService(new BotSessionStorage(cx.database), runtime);
    const services = {
        forProject: (project: ProjectStorageContext) => {
            return { targets: new BotTargetService(new BotConnectionStorage(project, cx.databases)) };
        },
    };
    const recovery = new SessionRecoveryService({ ...cx, runtime, bots, services });
    const operations = new DoService({ services: { runtime, bots, recovery } });
    return { application: createDoRoutes(runtime, bots, operations), services: { recovery, operations } };
}

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly gateways: {
        readonly databaseResolver: DatabaseResolver;
        readonly projectStorageDirectory: ProjectStorageDirectory;
        readonly sessions: SessionCommandGateway &
            SessionQueryGateway &
            Pick<RemoteSessionRuntime, "listRuntimeSessionIds" | "disconnectSession">;
        readonly botSessions: BotSessionRuntime;
        readonly peers: RuntimePeers;
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
    };
}) {
    const forProject = async (scope: ProjectScope, signal: AbortSignal) => {
        const project = await cx.gateways.projectStorageDirectory.resolve(scope.projectId, signal);
        signal.throwIfAborted();
        if (project.projectId !== scope.projectId) {
            throw new Error("The Project placement is invalid");
        }
        const database = cx.gateways.databaseResolver.resolve(project.storagePlacement);
        const conversations = new BotConversationStorage(project, cx.gateways.databaseResolver);
        const context = {
            bots: new BotRuntimeService({
                services: {
                    targets: new BotTargetService(new BotConnectionStorage(project, cx.gateways.databaseResolver)),
                    conversations: new BotConversationService(conversations),
                },
                storages: {
                    control: new BotControlStorage(project, cx.gateways.databaseResolver),
                },
            }),
            credentials: new ChannelCredentialService(new ChannelCredentialStorage(database)),
        };
        return context;
    };
    const bots: Pick<
        BotRuntimeService,
        | "approveBinding"
        | "rejectBinding"
        | "listPendingControl"
        | "listPendingProvisioning"
        | "activateConversation"
        | "failConversationProvisioning"
    > = {
        approveBinding: async (scope, runtimeId, event, now, signal) =>
            (await forProject(scope, signal)).bots.approveBinding(scope, runtimeId, event, now, signal),
        rejectBinding: async (scope, runtimeId, event, now, signal) =>
            (await forProject(scope, signal)).bots.rejectBinding(scope, runtimeId, event, now, signal),
        listPendingControl: async (scope, runtimeId, limit, signal) =>
            (await forProject(scope, signal)).bots.listPendingControl(scope, runtimeId, limit, signal),
        listPendingProvisioning: async (scope, runtimeId, limit, signal) =>
            (await forProject(scope, signal)).bots.listPendingProvisioning(scope, runtimeId, limit, signal),
        activateConversation: async (scope, conversationId, now, signal) =>
            (await forProject(scope, signal)).bots.activateConversation(scope, conversationId, now, signal),
        failConversationProvisioning: async (scope, conversationId, code, now, signal) =>
            (await forProject(scope, signal)).bots.failConversationProvisioning(
                scope,
                conversationId,
                code,
                now,
                signal,
            ),
    };
    const credentials: Pick<ChannelCredentialService, "isActive"> = {
        isActive: async (identity, signal) => {
            const scope = new ProjectScope(identity.projectId);
            return (await forProject(scope, signal)).credentials.isActive(identity, signal);
        },
    };
    const services = {
        bots,
        credentials,
        recovery: new RuntimeRecoveryService({ services: { bots }, gateways: cx.gateways }),
        connections: new RuntimeConnectionService(new RuntimeConnectionStorage(cx.database)),
        channel: (runtimeId: string, scope: ProjectScope) =>
            new ChannelActor({
                config: { runtimeId, scope },
                gateways: { commands: cx.gateways.sessions, queries: cx.gateways.sessions, peers: cx.gateways.peers },
            }),
    };
    return {
        services: {
            bots,
            credentials,
            recovery: services.recovery,
            connections: services.connections,
            runtime: new RuntimeService({ services, gateways: cx.gateways }),
        },
        gateways: cx.gateways,
    };
}

function createBotDeliveryDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}) {
    const deliveries = new BotDeliveryService(new BotDeliveryStorage(cx.database), cx.schedule);
    return { services: { deliveries }, application: createBotDeliveryRoutes(deliveries) };
}

export type DurableObjectContext = ReturnType<typeof createDurableObjectDependencies>;

export function createDurableObjectDependencies(cx: {
    readonly doDatabase: DoSqlDatabase;
    readonly content: SessionContentConfiguration;
    readonly quota: SessionQuotaPolicy;
    readonly gateways: Omit<
        Parameters<typeof createRuntimeRelayDependencies>[0]["gateways"],
        "sessions" | "botSessions"
    > & {
        readonly sessionTransport: SessionTransport;
        readonly connections: BotConnectionGateway;
    };
}) {
    const sessions = new RemoteSessionRuntime({
        storages: { directory: new SessionDirectoryStorage(cx.gateways.databaseResolver) },
        config: { quotaPolicy: new StaticSessionQuotaPolicyProvider(cx.quota) },
        gateways: {
            transport: cx.gateways.sessionTransport,
            databaseResolver: cx.gateways.databaseResolver,
            projectStorageDirectory: cx.gateways.projectStorageDirectory,
        },
    });
    const gateways = {
        ...cx.gateways,
        sessions,
        botSessions: new RemoteBotSessionRuntime(cx.gateways.sessionTransport, sessions, sessions),
    };
    const runtime = createRuntimeRelayDependencies({ database: cx.doDatabase, gateways });
    const session = createSessionRelayDependencies({
        database: cx.doDatabase,
        content: cx.content,
        quota: cx.quota,
        databases: cx.gateways.databaseResolver,
        projects: cx.gateways.projectStorageDirectory,
        connections: cx.gateways.connections,
        schedule: cx.gateways.schedule,
    });
    const delivery = createBotDeliveryDependencies({ database: cx.doDatabase, schedule: cx.gateways.schedule });
    return {
        doDatabase: cx.doDatabase,
        gateways,
        services: {
            ...runtime.services,
            sessionRecovery: session.services.recovery,
            operations: session.services.operations,
            ...delivery.services,
        },
        applications: {
            runtime: createRuntimeRoutes(runtime.services.runtime),
            session: session.application,
            delivery: delivery.application,
        },
    };
}
