import { DEFAULT_SESSION_QUOTA_POLICY, type SessionQuotaPolicy } from "./service/session/session.ts";
import { SessionArchiveService } from "./service/session/session-archive-service.ts";
import { SessionArtifactService } from "./service/session/session-artifact-service.ts";
import { SessionCommandService } from "./service/session/session-command-service.ts";
import { SessionEventProjector } from "./service/session/session-event-projector.ts";
import { SessionEventStreams } from "./service/session/session-event-stream.ts";
import { SessionInteractionService } from "./service/session/session-interaction-service.ts";
import { SessionLifecycleService } from "./service/session/session-lifecycle-service.ts";
import { SessionQueryService } from "./service/session/session-query-service.ts";
import { SessionStateService } from "./service/session/session-state-service.ts";
import { SessionTransferService } from "./service/session/session-transfer-service.ts";
import type { ImmutableContentStore } from "./storage/content-storage.ts";
import { SessionArchiveStorage } from "./storage/session/session-archive-storage.ts";
import { SessionArtifactStorage } from "./storage/session/session-artifact-storage.ts";
import { SessionCommandsStorage } from "./storage/session/session-commands-storage.ts";
import { SessionDeletionStorage } from "./storage/session/session-deletion-storage.ts";
import { SessionEventProjectorStorage } from "./storage/session/session-event-projector-storage.ts";
import { SessionInteractionsStorage } from "./storage/session/session-interactions-storage.ts";
import { SessionLifecycleStorage } from "./storage/session/session-lifecycle-storage.ts";
import { SessionQueriesStorage } from "./storage/session/session-queries-storage.ts";
import type { SessionSqlDatabase } from "./storage/session/session-sql-database.ts";
import { SessionStateStorage } from "./storage/session/session-state-storage.ts";
import { SessionTransferStorage } from "./storage/session/session-transfer-storage.ts";

export interface SessionInfrastructure {
    readonly gateways: { readonly database: SessionSqlDatabase; readonly content: ImmutableContentStore };
    readonly config: { readonly quota?: SessionQuotaPolicy };
}

export function createSessionDependencies(infrastructure: SessionInfrastructure) {
    const storages = Object.freeze({
        archive: new SessionArchiveStorage(infrastructure),
        artifacts: new SessionArtifactStorage(infrastructure),
        commands: new SessionCommandsStorage(infrastructure),
        deletions: new SessionDeletionStorage(infrastructure),
        eventProjector: new SessionEventProjectorStorage(infrastructure),
        interactions: new SessionInteractionsStorage(infrastructure),
        lifecycle: new SessionLifecycleStorage(infrastructure),
        queries: new SessionQueriesStorage(infrastructure),
        state: new SessionStateStorage(infrastructure),
        transfers: new SessionTransferStorage(infrastructure),
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
