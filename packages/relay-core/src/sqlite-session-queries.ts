import {
  AGENT_ACTIVITY_KIND,
  type Attempt,
  type CommittedSessionEvent,
  decodeNativeSessionHistory,
  decodeRecordedSessionEvent,
  decodeSessionPromptCommand,
  type Interaction,
  type NativeSessionHistory,
  type SessionPromptCommand,
  type Turn,
} from "@moxt-ai/mobius-protocol";
import {
  decodeDirectoryCursor,
  decodeEventCursor,
  decodeMessageCursor,
  encodeCursor,
} from "./session-cursors.ts";
import {
  type ActivityDetail,
  type ProjectScope,
  type SessionDirectoryPage,
  type SessionEventPage,
  type SessionMessage,
  type SessionMessagePage,
  SessionRuntimeError,
  type SessionSummary,
} from "./session-runtime.ts";
import type {
  SessionSqlDatabase,
  SessionSqlRow,
  SessionSqlValue,
} from "./session-sql-database.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";
import type { SqliteSessionArchive } from "./sqlite-session-archive.ts";
import {
  attemptFromResourceRow,
  attemptSummaryFromRow,
  committedFromRow,
  decodeActivityDetailPayload,
  eventCursor,
  interactionFromRow,
  lifecycleFromRow,
  scopeKey,
  summaryFromRow,
  turnFromRow,
  validateDomainIdentifier,
  validateLimit,
} from "./sqlite-session-records.ts";
import type { SqliteSessionStore } from "./sqlite-session-store.ts";

export class SqliteSessionQueries {
  readonly #archive: SqliteSessionArchive;
  readonly #database: SessionSqlDatabase;
  readonly #store: SqliteSessionStore;

  constructor(
    database: SessionSqlDatabase,
    archive: SqliteSessionArchive,
    store: SqliteSessionStore,
  ) {
    this.#archive = archive;
    this.#database = database;
    this.#store = store;
  }
  readonly readSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    return summaryFromRow(
      this.#store.requireActiveSessionRow(scope, sessionId, Date.now()),
    );
  };

  readonly readNativeHistory = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<NativeSessionHistory | null> => {
    signal.throwIfAborted();
    const row = this.#store.requireActiveSessionRow(
      scope,
      sessionId,
      Date.now(),
    );
    const encoded = rowNullableString(row, "native_history_json");
    if (encoded === null) {
      return null;
    }
    try {
      return decodeNativeSessionHistory(JSON.parse(encoded));
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The stored native Session history is invalid",
        { cause },
      );
    }
  };

  readonly readTurn = async (
    scope: ProjectScope,
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Turn> => {
    signal.throwIfAborted();
    this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
    validateDomainIdentifier(turnId, "turn");
    const row = this.#database.query(
      `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
      [scopeKey(scope), sessionId, turnId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "session_not_found",
        "The Turn does not exist",
      );
    }
    return turnFromRow(row);
  };

  readonly readAttempt = async (
    scope: ProjectScope,
    sessionId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<Attempt> => {
    signal.throwIfAborted();
    this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
    validateDomainIdentifier(attemptId, "attempt");
    const row = this.#database.query(
      `SELECT * FROM attempts
       WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
      [scopeKey(scope), sessionId, attemptId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "session_not_found",
        "The Attempt does not exist",
      );
    }
    return attemptFromResourceRow(row);
  };

  readonly readInteraction = async (
    scope: ProjectScope,
    sessionId: string,
    interactionId: string,
    signal: AbortSignal,
  ): Promise<Interaction> => {
    signal.throwIfAborted();
    this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
    validateDomainIdentifier(interactionId, "interaction");
    const row = this.#database.query(
      `SELECT * FROM interactions
       WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
      [scopeKey(scope), sessionId, interactionId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "interaction_not_found",
        "The Interaction does not exist",
      );
    }
    return interactionFromRow(row);
  };

  readonly readPendingInteractions = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<readonly Interaction[]> => {
    signal.throwIfAborted();
    this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
    const rows = this.#database.query(
      `SELECT i.* FROM interactions i
       INNER JOIN attempts a
         ON a.scope_key = i.scope_key
        AND a.session_id = i.session_id
        AND a.attempt_id = i.attempt_id
       WHERE i.scope_key = ? AND i.session_id = ?
         AND i.state IN ('pending', 'responded')
         AND a.state = 'waiting_input'
       ORDER BY i.interaction_id
       LIMIT 101`,
      [scopeKey(scope), sessionId],
    );
    if (rows.length > 100) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The Session has too many pending Interactions",
      );
    }
    signal.throwIfAborted();
    return rows.map(interactionFromRow);
  };

  readonly listSessions = async (
    scope: ProjectScope,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionDirectoryPage> => {
    signal.throwIfAborted();
    validateLimit(limit);
    const decoded =
      cursor === null ? null : decodeDirectoryCursor(cursor, scope);
    const values: SessionSqlValue[] = [scopeKey(scope)];
    let boundary = "";
    if (decoded !== null) {
      boundary = "AND (updated_at < ? OR (updated_at = ? AND session_id < ?))";
      values.push(decoded.updatedAt, decoded.updatedAt, decoded.sessionId);
    }
    values.push(limit + 1);
    const rows = this.#database.query(
      `SELECT * FROM sessions
       WHERE scope_key = ? AND lifecycle = 'ready' ${boundary}
       ORDER BY updated_at DESC, session_id DESC
       LIMIT ?`,
      values,
    );
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({
              projectId: scope.projectId,
              sessionId: rowString(last, "session_id"),
              tenantId: scope.tenantId,
              updatedAt: rowNumber(last, "updated_at"),
            })
          : null,
      sessions: pageRows.map(summaryFromRow),
    };
  };

  readonly readEvents = async (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionEventPage> => {
    signal.throwIfAborted();
    validateLimit(limit);
    const session = this.#store.requireActiveSessionRow(
      scope,
      sessionId,
      Date.now(),
    );
    const minimum = rowNumber(session, "minimum_sequence");
    const decoded =
      cursor === null ? null : decodeEventCursor(cursor, scope, sessionId);
    const sequence = decoded?.sequence ?? minimum - 1;
    if (decoded !== null && sequence < minimum - 1) {
      throw new SessionRuntimeError(
        "cursor_expired",
        "The event cursor has expired",
      );
    }
    const rows = this.#database.query(
      `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, archive_segment_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ? AND sequence_number > ?
       ORDER BY sequence_number
       LIMIT ?`,
      [scopeKey(scope), sessionId, sequence, limit + 1],
    );
    const pageRows = rows.slice(0, limit);
    const events: CommittedSessionEvent[] = [];
    for (const row of pageRows) {
      const payload = await this.#archive.readEventPayload(
        scope,
        sessionId,
        row,
        signal,
      );
      events.push(committedFromRow(row, scope, sessionId, payload));
    }
    const last = pageRows.at(-1);
    const nextSequence =
      last === undefined ? sequence : rowNumber(last, "sequence_number");
    return {
      cursor: eventCursor(scope, sessionId, nextSequence),
      events,
      hasMore: rows.length > limit,
    };
  };

  readonly readMessages = async (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionMessagePage> => {
    signal.throwIfAborted();
    validateLimit(limit);
    this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
    const decoded =
      cursor === null ? null : decodeMessageCursor(cursor, scope, sessionId);
    const values: SessionSqlValue[] = [scopeKey(scope), sessionId];
    let boundary = "";
    if (decoded !== null) {
      boundary = "AND (created_at < ? OR (created_at = ? AND command_id < ?))";
      values.push(decoded.createdAt, decoded.createdAt, decoded.commandId);
    }
    values.push(limit + 1);
    const rows = this.#database.query(
      `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ? ${boundary}
       ORDER BY created_at DESC, command_id DESC
       LIMIT ?`,
      values,
    );
    const pageRows = rows.slice(0, limit);
    const messages = pageRows.map((row) =>
      this.messageFromRow(scope, sessionId, row),
    );
    const last = pageRows.at(-1);
    return {
      messages,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({
              commandId: rowString(last, "command_id"),
              createdAt: rowNumber(last, "created_at"),
              projectId: scope.projectId,
              sessionId,
              tenantId: scope.tenantId,
            })
          : null,
    };
  };

  readonly readToolCallDetail = async (
    scope: ProjectScope,
    sessionId: string,
    attemptId: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<ActivityDetail> => {
    signal.throwIfAborted();
    validateDomainIdentifier(attemptId, "attempt");
    validateDomainIdentifier(toolCallId, "tool call");
    const session = this.#store.sessionRow(scope, sessionId);
    if (session === null) {
      throw new SessionRuntimeError(
        "session_not_found",
        "The session does not exist",
      );
    }
    const lifecycle = lifecycleFromRow(session);
    if (lifecycle.kind === "deleted") {
      return { deletedAt: lifecycle.completedAt, kind: "deleted" };
    }
    if (lifecycle.kind === "deleting") {
      throw new SessionRuntimeError(
        "session_deleted",
        "The session is being deleted",
      );
    }
    const row = this.#database.query(
      `SELECT detail_kind, detail_artifact_id, hot_detail,
              captured_bytes, original_bytes
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
         AND activity_id = ?`,
      [scopeKey(scope), sessionId, attemptId, toolCallId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "artifact_not_found",
        "The activity detail does not exist",
      );
    }
    const kind = rowString(row, "detail_kind");
    if (kind === "unrecorded") {
      return { kind: "unrecorded" };
    }
    if (kind === "truncated") {
      return {
        capturedBytes: rowNumber(row, "captured_bytes"),
        kind: "truncated",
        originalBytes: rowNumber(row, "original_bytes"),
      };
    }
    if (kind !== "available") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity detail state is invalid",
      );
    }
    const artifactId = rowNullableString(row, "detail_artifact_id");
    if (artifactId === null) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity archive reference is missing",
      );
    }
    const hot = rowNullableString(row, "hot_detail");
    const encoded =
      hot ??
      (await this.#archive.readArtifact(scope, sessionId, artifactId, signal));
    const detail = decodeActivityDetailPayload(
      encoded,
      "session_storage_unavailable",
      "The activity detail is invalid",
    );
    return {
      artifactId,
      content: detail.content,
      input: detail.input,
      kind: "available",
      output: detail.output,
      storage: hot === null ? "archive" : "hot",
    };
  };

  private readonly messageFromRow = (
    scope: ProjectScope,
    sessionId: string,
    row: SessionSqlRow,
  ): SessionMessage => {
    let command: SessionPromptCommand;
    try {
      command = decodeSessionPromptCommand(rowString(row, "command_json"));
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The stored command is invalid",
        { cause },
      );
    }
    const activityRows = this.#database.query(
      `SELECT attempt_id, summary_json, detail_kind
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND command_id = ?
       ORDER BY event_sequence`,
      [scopeKey(scope), sessionId, command.commandId],
    );
    const activities = activityRows.map((activityRow) => {
      const event = decodeRecordedSessionEvent(
        rowString(activityRow, "summary_json"),
      );
      if (event.kind !== AGENT_ACTIVITY_KIND) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The stored activity summary is invalid",
        );
      }
      const detailKind = rowString(activityRow, "detail_kind");
      if (
        detailKind !== "available" &&
        detailKind !== "truncated" &&
        detailKind !== "unrecorded"
      ) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The stored activity availability is invalid",
        );
      }
      const detailAvailability: SessionMessage["activities"][number]["detailAvailability"] =
        detailKind;
      return {
        activityId: event.activityId,
        attemptId: rowString(activityRow, "attempt_id"),
        activityType: event.activityType,
        detailAvailability,
        input: event.input,
        locations: event.locations,
        name: event.name,
        output: event.output,
        sequence: event.sequence,
        status: event.status,
        title: event.title,
        toolCallId: event.activityId,
        toolKind: event.toolKind,
      };
    });
    return {
      activities,
      additionalDirectoryIds: command.additionalDirectoryIds,
      agentId: command.agentId,
      attempt: attemptSummaryFromRow(row),
      commandId: command.commandId,
      createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
      images: command.images,
      prompt: command.prompt,
      resources: command.resources,
      response: rowString(row, "response"),
      sessionId,
    };
  };
}
