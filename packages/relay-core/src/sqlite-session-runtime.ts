import type { ImmutableContentStore } from "./content-storage.ts";
import { SessionEventStreams } from "./session-event-stream.ts";
import {
    type CreateSessionBindingRequest,
    DEFAULT_SESSION_QUOTA_POLICY,
    type ProjectScope,
    type SessionExport,
    type SessionQuotaPolicy,
    type SessionRuntime,
    type SessionSummary,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { SqliteSessionArchive } from "./sqlite-session-archive.ts";
import { SqliteSessionArtifacts } from "./sqlite-session-artifacts.ts";
import { SqliteSessionCommands } from "./sqlite-session-commands.ts";
import { SqliteSessionEventProjector } from "./sqlite-session-event-projector.ts";
import { SqliteSessionInteractions } from "./sqlite-session-interactions.ts";
import { SqliteSessionLifecycle } from "./sqlite-session-lifecycle.ts";
import { SqliteSessionQueries } from "./sqlite-session-queries.ts";
import { initializeSessionSchema } from "./sqlite-session-schema.ts";
import { SqliteSessionStore } from "./sqlite-session-store.ts";
import { SqliteSessionTransfer } from "./sqlite-session-transfer.ts";

export type {
    SessionSqlDatabase,
    SessionSqlRow,
    SessionSqlValue,
} from "./session-sql-database.ts";
export { validateCreateSessionRequest } from "./sqlite-session-records.ts";

export class SqliteSessionRuntime implements SessionRuntime {
    readonly #archive: SqliteSessionArchive;
    readonly #artifacts: SqliteSessionArtifacts;
    readonly #commands: SqliteSessionCommands;
    readonly #database: SessionSqlDatabase;
    readonly #eventProjector: SqliteSessionEventProjector;
    readonly #eventStreams: SessionEventStreams;
    readonly #interactions: SqliteSessionInteractions;
    readonly #lifecycle: SqliteSessionLifecycle;
    readonly #queries: SqliteSessionQueries;
    readonly #store: SqliteSessionStore;
    readonly #transfer: SqliteSessionTransfer;

    constructor(
        database: SessionSqlDatabase,
        content: ImmutableContentStore,
        quota: SessionQuotaPolicy = DEFAULT_SESSION_QUOTA_POLICY,
    ) {
        this.#archive = new SqliteSessionArchive(database, content);
        this.#database = database;
        this.#eventProjector = new SqliteSessionEventProjector(database);
        this.#store = new SqliteSessionStore(database, quota);
        this.#artifacts = new SqliteSessionArtifacts(database, content, this.#store);
        this.#lifecycle = new SqliteSessionLifecycle(database, this.#archive, this.#store);
        this.#queries = new SqliteSessionQueries(database, this.#archive, this.#store);
        this.#eventStreams = new SessionEventStreams(this.#queries);
        this.#interactions = new SqliteSessionInteractions(database, this.#queries, this.#store);
        this.#commands = new SqliteSessionCommands(
            database,
            this.#archive,
            this.#eventProjector,
            this.#lifecycle,
            this.#store,
        );
        this.#transfer = new SqliteSessionTransfer(database, this.#archive, this.#artifacts, this.#store);
        initializeSessionSchema(this.#database);
    }

    readonly createSession: SessionRuntime["createSession"] = (...parameters) =>
        this.#lifecycle.createSession(...parameters);

    readonly acceptTurn: SessionRuntime["acceptTurn"] = (...parameters) => this.#commands.acceptTurn(...parameters);

    readonly acceptTurnCancellation: SessionRuntime["acceptTurnCancellation"] = (...parameters) =>
        this.#commands.acceptTurnCancellation(...parameters);

    readonly commitEvent: SessionRuntime["commitEvent"] = async (...parameters) => {
        const result = await this.#commands.commitEvent(...parameters);
        if (!result.duplicate) {
            this.#eventStreams.publish(parameters[0], result.committed);
        }
        return result;
    };

    readonly setDefaultBinding: SessionRuntime["setDefaultBinding"] = (...parameters) =>
        this.#commands.setDefaultBinding(...parameters);

    readonly recordNativeHistory: SessionRuntime["recordNativeHistory"] = (...parameters) =>
        this.#lifecycle.recordNativeHistory(...parameters);

    readonly acceptInteractionResponse: SessionRuntime["acceptInteractionResponse"] = (...parameters) =>
        this.#interactions.acceptInteractionResponse(...parameters);

    readonly listPendingDaemonDeliveries: SessionRuntime["listPendingDaemonDeliveries"] = (...parameters) =>
        this.#interactions.listPendingDaemonDeliveries(...parameters);

    readonly markPendingWorkCompleted: SessionRuntime["markPendingWorkCompleted"] = (...parameters) =>
        this.#interactions.markPendingWorkCompleted(...parameters);

    readonly reconcileAttempt: SessionRuntime["reconcileAttempt"] = (...parameters) =>
        this.#interactions.reconcileAttempt(...parameters);

    readonly markRuntimeDisconnected: SessionRuntime["markRuntimeDisconnected"] = (...parameters) =>
        this.#commands.markRuntimeDisconnected(...parameters);

    readonly deleteSession: SessionRuntime["deleteSession"] = (...parameters) =>
        this.#lifecycle.deleteSession(...parameters);

    readonly readSession: SessionRuntime["readSession"] = (...parameters) => this.#queries.readSession(...parameters);

    readonly readNativeHistory: SessionRuntime["readNativeHistory"] = (...parameters) =>
        this.#queries.readNativeHistory(...parameters);

    readonly readTurn: SessionRuntime["readTurn"] = (...parameters) => this.#queries.readTurn(...parameters);

    readonly readTurnRuntime: SessionRuntime["readTurnRuntime"] = (...parameters) =>
        this.#queries.readTurnRuntime(...parameters);

    readonly readCommandRuntime: SessionRuntime["readCommandRuntime"] = (...parameters) =>
        this.#queries.readCommandRuntime(...parameters);

    readonly readAttempt: SessionRuntime["readAttempt"] = (...parameters) => this.#queries.readAttempt(...parameters);

    readonly readInteraction: SessionRuntime["readInteraction"] = (...parameters) =>
        this.#queries.readInteraction(...parameters);

    readonly readInteractionRuntime: SessionRuntime["readInteractionRuntime"] = (...parameters) =>
        this.#queries.readInteractionRuntime(...parameters);

    readonly readPendingInteractions: SessionRuntime["readPendingInteractions"] = (...parameters) =>
        this.#queries.readPendingInteractions(...parameters);

    readonly listSessions: SessionRuntime["listSessions"] = (...parameters) =>
        this.#queries.listSessions(...parameters);

    readonly readEvents: SessionRuntime["readEvents"] = (...parameters) => this.#queries.readEvents(...parameters);

    readonly readMessages: SessionRuntime["readMessages"] = (...parameters) =>
        this.#queries.readMessages(...parameters);

    readonly readToolCallDetail: SessionRuntime["readToolCallDetail"] = (...parameters) =>
        this.#queries.readToolCallDetail(...parameters);

    readonly createArtifactUpload: SessionRuntime["createArtifactUpload"] = (...parameters) =>
        this.#artifacts.createUpload(...parameters);

    readonly authorizeArtifactUpload: SessionRuntime["authorizeArtifactUpload"] = (...parameters) =>
        this.#artifacts.authorizeUpload(...parameters);

    readonly completeArtifactUpload: SessionRuntime["completeArtifactUpload"] = (...parameters) =>
        this.#artifacts.completeUpload(...parameters);

    readonly readArtifact: SessionRuntime["readArtifact"] = (...parameters) => this.#artifacts.read(...parameters);

    readonly readArtifactContent: SessionRuntime["readArtifactContent"] = (...parameters) =>
        this.#artifacts.readContent(...parameters);

    readonly resolveArtifactResources: SessionRuntime["resolveArtifactResources"] = (...parameters) =>
        this.#artifacts.resolveResources(...parameters);

    readonly openEventStream: SessionRuntime["openEventStream"] = (...parameters) =>
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
