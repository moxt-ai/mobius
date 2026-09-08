import type {
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "../../gateway/index.ts";
import type { ImmutableContentStore } from "../../storage/content-storage.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import { initializeSessionSchema } from "../../storage/session/sqlite-session-schema.ts";
import {
    type CreateSessionBindingRequest,
    DEFAULT_SESSION_QUOTA_POLICY,
    type ProjectScope,
    type SessionExport,
    type SessionQuotaPolicy,
    type SessionSummary,
} from "./session.ts";
import { SessionArchiveService } from "./session-archive-service.ts";
import { SessionArtifactService } from "./session-artifact-service.ts";
import { SessionCommandService } from "./session-command-service.ts";
import { SessionEventProjector } from "./session-event-projector.ts";
import { SessionEventStreams } from "./session-event-stream.ts";
import { SessionInteractionService } from "./session-interaction-service.ts";
import { SessionLifecycleService } from "./session-lifecycle-service.ts";
import { SessionQueryService } from "./session-query-service.ts";
import { SessionStateService } from "./session-state-service.ts";
import { SessionTransferService } from "./session-transfer-service.ts";

export type {
    SessionSqlDatabase,
    SessionSqlRow,
    SessionSqlValue,
} from "../../storage/session/session-sql-database.ts";
export { validateCreateSessionRequest } from "./session-records.ts";

export class SqliteSessionRuntime
    implements
        SessionCommandGateway,
        SessionQueryGateway,
        SessionArtifactGateway,
        SessionEventStreamGateway,
        SessionTransferGateway
{
    readonly #archive: SessionArchiveService;
    readonly #artifacts: SessionArtifactService;
    readonly #commands: SessionCommandService;
    readonly #database: SessionSqlDatabase;
    readonly #eventProjector: SessionEventProjector;
    readonly #eventStreams: SessionEventStreams;
    readonly #interactions: SessionInteractionService;
    readonly #lifecycle: SessionLifecycleService;
    readonly #queries: SessionQueryService;
    readonly #store: SessionStateService;
    readonly #transfer: SessionTransferService;

    constructor(
        database: SessionSqlDatabase,
        content: ImmutableContentStore,
        quota: SessionQuotaPolicy = DEFAULT_SESSION_QUOTA_POLICY,
    ) {
        this.#archive = new SessionArchiveService(database, content);
        this.#database = database;
        this.#eventProjector = new SessionEventProjector(database);
        this.#store = new SessionStateService(database, quota);
        this.#artifacts = new SessionArtifactService(database, content, this.#store);
        this.#lifecycle = new SessionLifecycleService(database, this.#archive, this.#store);
        this.#queries = new SessionQueryService(database, this.#archive, this.#store);
        this.#eventStreams = new SessionEventStreams(this.#queries);
        this.#interactions = new SessionInteractionService(database, this.#queries, this.#store);
        this.#commands = new SessionCommandService(
            database,
            this.#archive,
            this.#eventProjector,
            this.#lifecycle,
            this.#store,
        );
        this.#transfer = new SessionTransferService(database, this.#archive, this.#artifacts, this.#store);
        initializeSessionSchema(this.#database);
    }

    readonly createSession: SessionCommandGateway["createSession"] = (...parameters) =>
        this.#lifecycle.createSession(...parameters);

    readonly acceptTurn: SessionCommandGateway["acceptTurn"] = (...parameters) =>
        this.#commands.acceptTurn(...parameters);

    readonly acceptTurnCancellation: SessionCommandGateway["acceptTurnCancellation"] = (...parameters) =>
        this.#commands.acceptTurnCancellation(...parameters);

    readonly commitEvent: SessionCommandGateway["commitEvent"] = async (...parameters) => {
        const result = await this.#commands.commitEvent(...parameters);
        if (!result.duplicate) {
            this.#eventStreams.publish(parameters[0], result.committed);
        }
        return result;
    };

    readonly setDefaultBinding: SessionCommandGateway["setDefaultBinding"] = (...parameters) =>
        this.#commands.setDefaultBinding(...parameters);

    readonly recordNativeHistory: SessionCommandGateway["recordNativeHistory"] = (...parameters) =>
        this.#lifecycle.recordNativeHistory(...parameters);

    readonly acceptInteractionResponse: SessionCommandGateway["acceptInteractionResponse"] = (...parameters) =>
        this.#interactions.acceptInteractionResponse(...parameters);

    readonly listPendingDaemonDeliveries: SessionCommandGateway["listPendingDaemonDeliveries"] = (...parameters) =>
        this.#interactions.listPendingDaemonDeliveries(...parameters);

    readonly markPendingWorkCompleted: SessionCommandGateway["markPendingWorkCompleted"] = (...parameters) =>
        this.#interactions.markPendingWorkCompleted(...parameters);

    readonly reconcileAttempt: SessionCommandGateway["reconcileAttempt"] = (...parameters) =>
        this.#interactions.reconcileAttempt(...parameters);

    readonly markRuntimeDisconnected: SessionCommandGateway["markRuntimeDisconnected"] = (...parameters) =>
        this.#commands.markRuntimeDisconnected(...parameters);

    readonly deleteSession: SessionCommandGateway["deleteSession"] = (...parameters) =>
        this.#lifecycle.deleteSession(...parameters);

    readonly readSession: SessionQueryGateway["readSession"] = (...parameters) =>
        this.#queries.readSession(...parameters);

    readonly readNativeHistory: SessionQueryGateway["readNativeHistory"] = (...parameters) =>
        this.#queries.readNativeHistory(...parameters);

    readonly readTurn: SessionQueryGateway["readTurn"] = (...parameters) => this.#queries.readTurn(...parameters);

    readonly readTurnRuntime: SessionQueryGateway["readTurnRuntime"] = (...parameters) =>
        this.#queries.readTurnRuntime(...parameters);

    readonly readCommandRuntime: SessionQueryGateway["readCommandRuntime"] = (...parameters) =>
        this.#queries.readCommandRuntime(...parameters);

    readonly readAttempt: SessionQueryGateway["readAttempt"] = (...parameters) =>
        this.#queries.readAttempt(...parameters);

    readonly readInteraction: SessionQueryGateway["readInteraction"] = (...parameters) =>
        this.#queries.readInteraction(...parameters);

    readonly readInteractionRuntime: SessionQueryGateway["readInteractionRuntime"] = (...parameters) =>
        this.#queries.readInteractionRuntime(...parameters);

    readonly readPendingInteractions: SessionQueryGateway["readPendingInteractions"] = (...parameters) =>
        this.#queries.readPendingInteractions(...parameters);

    readonly listSessions: SessionQueryGateway["listSessions"] = (...parameters) =>
        this.#queries.listSessions(...parameters);

    readonly readEvents: SessionQueryGateway["readEvents"] = (...parameters) => this.#queries.readEvents(...parameters);

    readonly readMessages: SessionQueryGateway["readMessages"] = (...parameters) =>
        this.#queries.readMessages(...parameters);

    readonly readToolCallDetail: SessionQueryGateway["readToolCallDetail"] = (...parameters) =>
        this.#queries.readToolCallDetail(...parameters);

    readonly createArtifactUpload: SessionArtifactGateway["createArtifactUpload"] = (...parameters) =>
        this.#artifacts.createUpload(...parameters);

    readonly authorizeArtifactUpload: SessionArtifactGateway["authorizeArtifactUpload"] = (...parameters) =>
        this.#artifacts.authorizeUpload(...parameters);

    readonly completeArtifactUpload: SessionArtifactGateway["completeArtifactUpload"] = (...parameters) =>
        this.#artifacts.completeUpload(...parameters);

    readonly readArtifact: SessionArtifactGateway["readArtifact"] = (...parameters) =>
        this.#artifacts.read(...parameters);

    readonly readArtifactContent: SessionArtifactGateway["readArtifactContent"] = (...parameters) =>
        this.#artifacts.readContent(...parameters);

    readonly resolveArtifactResources: SessionArtifactGateway["resolveArtifactResources"] = (...parameters) =>
        this.#artifacts.resolveResources(...parameters);

    readonly openEventStream: SessionEventStreamGateway["openEventStream"] = (...parameters) =>
        this.#eventStreams.open(...parameters);

    readonly closeEventStreams = (): void => {
        this.#eventStreams.close();
    };

    readonly runArchiveWork = async (scope: ProjectScope, sessionId: string, signal: AbortSignal): Promise<number> => {
        signal.throwIfAborted();
        this.#store.requireSessionRow(scope, sessionId, false);
        return await this.#archive.runWork(scope, sessionId, signal);
    };

    readonly exportSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionExport> => await this.#transfer.exportSession(scope, sessionId, signal, this.readNativeHistory);

    readonly importSession = async (
        scope: ProjectScope,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> =>
        await this.#transfer.importSession(scope, exported, targetBinding, now, signal, this.createSession);

    readonly hasPendingArchiveWork = (scope: ProjectScope, sessionId: string): boolean =>
        this.#archive.hasPendingWork(scope, sessionId);
}
