import type { ImmutableContentStore } from "./content-storage.ts";
import {
  DEFAULT_SESSION_QUOTA_POLICY,
  type ProjectScope,
  type SessionExport,
  type SessionQuotaPolicy,
  type SessionRuntime,
  type SessionSummary,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { SqliteSessionArchive } from "./sqlite-session-archive.ts";
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
  readonly #commands: SqliteSessionCommands;
  readonly #database: SessionSqlDatabase;
  readonly #eventProjector: SqliteSessionEventProjector;
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
    this.#lifecycle = new SqliteSessionLifecycle(
      database,
      this.#archive,
      this.#store,
    );
    this.#queries = new SqliteSessionQueries(
      database,
      this.#archive,
      this.#store,
    );
    this.#interactions = new SqliteSessionInteractions(
      database,
      this.#queries,
      this.#store,
    );
    this.#commands = new SqliteSessionCommands(
      database,
      this.#archive,
      this.#eventProjector,
      this.#lifecycle,
      this.#store,
    );
    this.#transfer = new SqliteSessionTransfer(
      database,
      this.#archive,
      this.#store,
    );
    initializeSessionSchema(this.#database);
  }

  readonly createSession: SessionRuntime["createSession"] = (...parameters) =>
    this.#lifecycle.createSession(...parameters);

  readonly acceptTurn: SessionRuntime["acceptTurn"] = (...parameters) =>
    this.#commands.acceptTurn(...parameters);

  readonly commitEvent: SessionRuntime["commitEvent"] = (...parameters) =>
    this.#commands.commitEvent(...parameters);

  readonly setDefaultBinding: SessionRuntime["setDefaultBinding"] = (
    ...parameters
  ) => this.#commands.setDefaultBinding(...parameters);

  readonly recordNativeHistory: SessionRuntime["recordNativeHistory"] = (
    ...parameters
  ) => this.#lifecycle.recordNativeHistory(...parameters);

  readonly acceptInteractionResponse: SessionRuntime["acceptInteractionResponse"] =
    (...parameters) =>
      this.#interactions.acceptInteractionResponse(...parameters);

  readonly listPendingDaemonDeliveries: SessionRuntime["listPendingDaemonDeliveries"] =
    (...parameters) =>
      this.#interactions.listPendingDaemonDeliveries(...parameters);

  readonly markPendingWorkCompleted: SessionRuntime["markPendingWorkCompleted"] =
    (...parameters) =>
      this.#interactions.markPendingWorkCompleted(...parameters);

  readonly reconcileAttempt: SessionRuntime["reconcileAttempt"] = (
    ...parameters
  ) => this.#interactions.reconcileAttempt(...parameters);

  readonly markRuntimeDisconnected: SessionRuntime["markRuntimeDisconnected"] =
    (...parameters) => this.#commands.markRuntimeDisconnected(...parameters);

  readonly deleteSession: SessionRuntime["deleteSession"] = (...parameters) =>
    this.#lifecycle.deleteSession(...parameters);

  readonly readSession: SessionRuntime["readSession"] = (...parameters) =>
    this.#queries.readSession(...parameters);

  readonly readNativeHistory: SessionRuntime["readNativeHistory"] = (
    ...parameters
  ) => this.#queries.readNativeHistory(...parameters);

  readonly readTurn: SessionRuntime["readTurn"] = (...parameters) =>
    this.#queries.readTurn(...parameters);

  readonly readAttempt: SessionRuntime["readAttempt"] = (...parameters) =>
    this.#queries.readAttempt(...parameters);

  readonly readInteraction: SessionRuntime["readInteraction"] = (
    ...parameters
  ) => this.#queries.readInteraction(...parameters);

  readonly readPendingInteractions: SessionRuntime["readPendingInteractions"] =
    (...parameters) => this.#queries.readPendingInteractions(...parameters);

  readonly listSessions: SessionRuntime["listSessions"] = (...parameters) =>
    this.#queries.listSessions(...parameters);

  readonly readEvents: SessionRuntime["readEvents"] = (...parameters) =>
    this.#queries.readEvents(...parameters);

  readonly readMessages: SessionRuntime["readMessages"] = (...parameters) =>
    this.#queries.readMessages(...parameters);

  readonly readToolCallDetail: SessionRuntime["readToolCallDetail"] = (
    ...parameters
  ) => this.#queries.readToolCallDetail(...parameters);

  readonly runArchiveWork = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<number> => {
    signal.throwIfAborted();
    this.#store.requireSessionRow(scope, sessionId, false);
    return await this.#archive.runWork(scope, sessionId, signal);
  };

  readonly exportSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionExport> =>
    await this.#transfer.exportSession(
      scope,
      sessionId,
      signal,
      this.readNativeHistory,
    );

  readonly importSession = async (
    scope: ProjectScope,
    exported: unknown,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> =>
    await this.#transfer.importSession(
      scope,
      exported,
      now,
      signal,
      this.createSession,
    );

  readonly hasPendingArchiveWork = (
    scope: ProjectScope,
    sessionId: string,
  ): boolean => this.#archive.hasPendingWork(scope, sessionId);
}
