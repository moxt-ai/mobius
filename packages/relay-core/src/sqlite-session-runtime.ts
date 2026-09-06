import {
  AGENT_ACTIVITY_KIND,
  AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT,
  AGENT_ACTIVITY_RECORDED_FIELD_LIMIT,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  type CommittedSessionEvent,
  decodeCommittedSessionEvent,
  decodeRecordedAgentContentValue,
  decodeRecordedSessionEvent,
  decodeSessionEventEnvelope,
  decodeSessionPromptCommand,
  encodeAgentActivityEvent,
  encodeCommittedSessionEvent,
  encodeSessionEventEnvelope,
  MOBIUS_PROTOCOL_VERSION,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_EVENT_COMMITTED_KIND,
  SESSION_EVENT_FORMAT_VERSION,
  SESSION_FAILED_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
  type SessionPromptCommand,
  validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";

import {
  ContentStorageError,
  ContentTarget,
  type ImmutableContentStore,
} from "./content-storage.ts";
import {
  type ActivityDetail,
  type AttemptSummary,
  type CommittedEventResult,
  CreateSessionRequest,
  DEFAULT_SESSION_QUOTA_POLICY,
  type ProjectScope,
  SESSION_EXPORT_FORMAT_VERSION,
  type SessionCommandAcceptance,
  type SessionDirectoryPage,
  type SessionEventPage,
  type SessionExport,
  type SessionLifecycle,
  type SessionMessage,
  type SessionMessagePage,
  type SessionQuotaPolicy,
  type SessionRuntime,
  SessionRuntimeError,
  type SessionSummary,
} from "./session-runtime.ts";

const CURSOR_FORMAT_VERSION = 1;
const ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT = 128 * 1024;
const ARCHIVE_SEGMENT_BYTE_LIMIT = 192 * 1024;
const MAX_ARCHIVE_BATCH_SIZE = 32;
const MAX_EXPORT_BYTE_LENGTH = 64 * 1024 * 1024;
const MIN_PENDING_ARCHIVE_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_PENDING_ARCHIVE_BYTE_LIMIT = 128 * 1024 * 1024;
const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_HOT_EVENT_LIMIT = 1_000;
const DEFAULT_CONTENT_LIMIT_BYTES = 6_000_000;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type SessionSqlValue = null | number | string;
export type SessionSqlRow = Readonly<Record<string, SessionSqlValue>>;

export interface SessionSqlDatabase {
  readonly exec: (script: string) => void;
  readonly query: (
    sql: string,
    values?: readonly SessionSqlValue[],
  ) => readonly SessionSqlRow[];
  readonly run: (
    sql: string,
    values?: readonly SessionSqlValue[],
  ) => { readonly changes: number };
  readonly transaction: <T>(operation: () => T) => T;
}

interface EventCursor {
  readonly formatVersion: typeof CURSOR_FORMAT_VERSION;
  readonly projectId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly tenantId: string;
}

interface MessageCursor {
  readonly commandId: string;
  readonly createdAt: number;
  readonly formatVersion: typeof CURSOR_FORMAT_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

interface DirectoryCursor {
  readonly formatVersion: typeof CURSOR_FORMAT_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly updatedAt: number;
}

interface PreparedEvent {
  readonly activityDetail: {
    readonly activityId: string;
    readonly artifactId: string;
    readonly payload: string;
  } | null;
  readonly event: RecordedSessionEvent;
  readonly payload: string;
}

interface ImportedCommand {
  readonly command: SessionPromptCommand;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly processAttemptId: string | null;
  readonly response: string;
  readonly startedAt: number | null;
  readonly state:
    | "accepted"
    | "completed"
    | "failed"
    | "outcome_unknown"
    | "running";
  readonly stopReason: string | null;
  readonly updatedAt: number;
}

interface ImportedActivity {
  readonly event: AgentActivityEvent;
  readonly eventSequence: number;
}

interface ArchiveSegment {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedByteLength: number;
}

function scopeKey(scope: ProjectScope): string {
  validateDomainIdentifier(scope.tenantId, "tenant");
  validateDomainIdentifier(scope.projectId, "project");
  return `${scope.tenantId}:${scope.projectId}`;
}

function validateDomainIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new SessionRuntimeError(
      "session_access_denied",
      `The ${field} identifier is invalid`,
    );
  }
  return value;
}

export function validateCreateSessionRequest(
  request: CreateSessionRequest,
): void {
  validateDomainIdentifier(request.sessionId, "session");
  validateDomainIdentifier(request.runtimeId, "runtime");
  validateDomainIdentifier(request.agentId, "agent");
  validateDomainIdentifier(request.bindingId, "binding");
  validateDomainIdentifier(request.directoryId, "directory");
  if (
    typeof request.title !== "string" ||
    request.title.length > 500 ||
    request.policy.retentionMilliseconds < 60_000 ||
    request.policy.retentionMilliseconds > 365 * 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(request.policy.retentionMilliseconds) ||
    request.policy.hotEventLimit < 10 ||
    request.policy.hotEventLimit > 10_000 ||
    !Number.isSafeInteger(request.policy.hotEventLimit) ||
    request.policy.contentLimitBytes < 1_024 ||
    request.policy.contentLimitBytes > DEFAULT_CONTENT_LIMIT_BYTES ||
    !Number.isSafeInteger(request.policy.contentLimitBytes) ||
    (request.policy.level !== "full" && request.policy.level !== "summary")
  ) {
    throw new SessionRuntimeError(
      "session_conflict",
      "The session recording policy is invalid",
    );
  }
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionRuntimeError(
      "session_conflict",
      "The session operation timestamp is invalid",
    );
  }
  return value;
}

function rowString(row: SessionSqlRow, key: string): string {
  const value = Reflect.get(row, key);
  if (typeof value !== "string") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session database returned an invalid record",
    );
  }
  return value;
}

function rowNullableString(row: SessionSqlRow, key: string): string | null {
  const value = Reflect.get(row, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session database returned an invalid record",
    );
  }
  return value;
}

function rowNumber(row: SessionSqlRow, key: string): number {
  const value = Reflect.get(row, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session database returned an invalid record",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function decodeActivityDetailPayload(
  encoded: string,
  code: "invalid_export" | "session_storage_unavailable",
  message: string,
): {
  readonly content: readonly unknown[];
  readonly input: string;
  readonly output: string;
} {
  try {
    const value: unknown = JSON.parse(encoded);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["content", "input", "output"]) ||
      !Array.isArray(value["content"]) ||
      value["content"].length > 100 ||
      typeof value["input"] !== "string" ||
      value["input"].length > AGENT_ACTIVITY_RECORDED_FIELD_LIMIT ||
      typeof value["output"] !== "string" ||
      value["output"].length > AGENT_ACTIVITY_RECORDED_FIELD_LIMIT ||
      encoded.length > AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT
    ) {
      throw new Error("Invalid activity detail");
    }
    return {
      content: value["content"].map((entry) =>
        decodeRecordedAgentContentValue(entry),
      ),
      input: value["input"],
      output: value["output"],
    };
  } catch (cause) {
    throw new SessionRuntimeError(code, message, { cause });
  }
}

function encodeCursor(
  value: EventCursor | MessageCursor | DirectoryCursor,
): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(encoded: string): Readonly<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
  }
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const value: unknown = JSON.parse(atob(`${base64}${padding}`));
    if (!isRecord(value)) {
      throw new Error("Cursor must be an object");
    }
    return value;
  } catch (cause) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid", {
      cause,
    });
  }
}

function decodeEventCursor(
  encoded: string,
  scope: ProjectScope,
  sessionId: string,
): EventCursor {
  const value = decodeCursor(encoded);
  const sequence = value["sequence"];
  if (
    value["formatVersion"] !== CURSOR_FORMAT_VERSION ||
    value["tenantId"] !== scope.tenantId ||
    value["projectId"] !== scope.projectId ||
    value["sessionId"] !== sessionId ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  ) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
  }
  return {
    formatVersion: CURSOR_FORMAT_VERSION,
    projectId: scope.projectId,
    sequence,
    sessionId,
    tenantId: scope.tenantId,
  };
}

function decodeMessageCursor(
  encoded: string,
  scope: ProjectScope,
  sessionId: string,
): MessageCursor {
  const value = decodeCursor(encoded);
  const commandId = value["commandId"];
  const createdAt = value["createdAt"];
  if (
    value["formatVersion"] !== CURSOR_FORMAT_VERSION ||
    value["tenantId"] !== scope.tenantId ||
    value["projectId"] !== scope.projectId ||
    value["sessionId"] !== sessionId ||
    typeof commandId !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
  }
  return {
    commandId,
    createdAt,
    formatVersion: CURSOR_FORMAT_VERSION,
    projectId: scope.projectId,
    sessionId,
    tenantId: scope.tenantId,
  };
}

function decodeDirectoryCursor(
  encoded: string,
  scope: ProjectScope,
): DirectoryCursor {
  const value = decodeCursor(encoded);
  const sessionId = value["sessionId"];
  const updatedAt = value["updatedAt"];
  if (
    value["formatVersion"] !== CURSOR_FORMAT_VERSION ||
    value["tenantId"] !== scope.tenantId ||
    value["projectId"] !== scope.projectId ||
    typeof sessionId !== "string" ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
  }
  return {
    formatVersion: CURSOR_FORMAT_VERSION,
    projectId: scope.projectId,
    sessionId,
    tenantId: scope.tenantId,
    updatedAt,
  };
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SessionRuntimeError(
      "invalid_page_size",
      "The page size must be between 1 and 100",
    );
  }
}

function lifecycleFromRow(row: SessionSqlRow): SessionLifecycle {
  const lifecycle = rowString(row, "lifecycle");
  if (lifecycle === "active") {
    return { kind: "active" };
  }
  if (lifecycle === "deleting") {
    return {
      kind: "deleting",
      requestedAt: new Date(
        rowNumber(row, "delete_requested_at"),
      ).toISOString(),
    };
  }
  if (lifecycle === "deleted") {
    return {
      completedAt: new Date(
        rowNumber(row, "delete_completed_at"),
      ).toISOString(),
      kind: "deleted",
    };
  }
  throw new SessionRuntimeError(
    "session_storage_unavailable",
    "The session lifecycle is invalid",
  );
}

function summaryFromRow(row: SessionSqlRow): SessionSummary {
  const recordingLevel = rowString(row, "recording_level");
  if (recordingLevel !== "full" && recordingLevel !== "summary") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session recording level is invalid",
    );
  }
  return {
    agentId: rowString(row, "agent_id"),
    createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
    lifecycle: lifecycleFromRow(row),
    policy: {
      contentLimitBytes: rowNumber(row, "content_limit_bytes"),
      hotEventLimit: rowNumber(row, "hot_event_limit"),
      level: recordingLevel,
      retentionMilliseconds: rowNumber(row, "retention_milliseconds"),
    },
    projectId: rowString(row, "project_id"),
    runtimeId: rowString(row, "runtime_id"),
    sessionId: rowString(row, "session_id"),
    tenantId: rowString(row, "tenant_id"),
    title: rowString(row, "title"),
    updatedAt: new Date(rowNumber(row, "updated_at")).toISOString(),
  };
}

function eventCursor(
  scope: ProjectScope,
  sessionId: string,
  sequence: number,
): string {
  return encodeCursor({
    formatVersion: CURSOR_FORMAT_VERSION,
    projectId: scope.projectId,
    sequence,
    sessionId,
    tenantId: scope.tenantId,
  });
}

function committedFromRow(
  row: SessionSqlRow,
  scope: ProjectScope,
  sessionId: string,
  payload: string,
): CommittedSessionEvent {
  return decodeCommittedSessionEvent(
    encodeCommittedSessionEvent({
      cursor: eventCursor(scope, sessionId, rowNumber(row, "sequence_number")),
      eventId: rowString(row, "event_id"),
      eventVersion: SESSION_EVENT_FORMAT_VERSION,
      kind: SESSION_EVENT_COMMITTED_KIND,
      payload,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      recordedAt: new Date(rowNumber(row, "recorded_at")).toISOString(),
      sequence: rowNumber(row, "sequence_number"),
      sessionId,
    }),
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function gzip(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const stream = new Blob([Uint8Array.from(bytes).buffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  signal.throwIfAborted();
  return compressed;
}

async function gunzip(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const stream = new Blob([Uint8Array.from(bytes).buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const uncompressed = new Uint8Array(await new Response(stream).arrayBuffer());
  signal.throwIfAborted();
  return uncompressed;
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(encoded);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseSegments(encoded: string): readonly ArchiveSegment[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The archive manifest is invalid",
      { cause },
    );
  }
  if (!Array.isArray(value)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The archive manifest is invalid",
    );
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive manifest is invalid",
      );
    }
    const artifactId = entry["artifactId"];
    const byteLength = entry["byteLength"];
    const digest = entry["sha256"];
    const storedByteLength = entry["storedByteLength"];
    if (
      typeof artifactId !== "string" ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      typeof storedByteLength !== "number" ||
      !Number.isSafeInteger(storedByteLength) ||
      storedByteLength < 0 ||
      storedByteLength > ARCHIVE_SEGMENT_BYTE_LIMIT ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive manifest is invalid",
      );
    }
    return { artifactId, byteLength, sha256: digest, storedByteLength };
  });
}

export class SqliteSessionRuntime implements SessionRuntime {
  readonly #content: ImmutableContentStore;
  readonly #database: SessionSqlDatabase;
  readonly #quota: SessionQuotaPolicy;

  constructor(
    database: SessionSqlDatabase,
    content: ImmutableContentStore,
    quota: SessionQuotaPolicy = DEFAULT_SESSION_QUOTA_POLICY,
  ) {
    this.#content = content;
    this.#database = database;
    this.#quota = quota;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_records (
        scope_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        directory_id TEXT NOT NULL,
        title TEXT NOT NULL,
        recording_level TEXT NOT NULL CHECK (recording_level IN ('full', 'summary')),
        retention_milliseconds INTEGER NOT NULL,
        hot_event_limit INTEGER NOT NULL,
        content_limit_bytes INTEGER NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'deleting', 'deleted')),
        delete_requested_at INTEGER NOT NULL DEFAULT 0,
        delete_completed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        minimum_sequence INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope_key, session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_records_directory
        ON session_records(scope_key, updated_at DESC, session_id DESC);
      CREATE TABLE IF NOT EXISTS session_commands (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'running', 'completed', 'failed', 'outcome_unknown')),
        response TEXT NOT NULL DEFAULT '',
        process_attempt_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_commands_page
        ON session_commands(scope_key, session_id, created_at DESC, command_id DESC);
      CREATE TABLE IF NOT EXISTS session_events (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload TEXT,
        artifact_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, sequence_number),
        UNIQUE (scope_key, session_id, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_activities (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        detail_kind TEXT NOT NULL CHECK (detail_kind IN ('available', 'truncated', 'unrecorded')),
        detail_artifact_id TEXT,
        hot_detail TEXT,
        captured_bytes INTEGER NOT NULL DEFAULT 0,
        original_bytes INTEGER NOT NULL DEFAULT 0,
        event_sequence INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, activity_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_archives (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        archive_kind TEXT NOT NULL CHECK (archive_kind IN ('activity', 'event')),
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        segments_json TEXT,
        PRIMARY KEY (scope_key, session_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_archive_jobs (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        archive_kind TEXT NOT NULL CHECK (archive_kind IN ('activity', 'event')),
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        hot_payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope_key, session_id, artifact_id)
      ) STRICT;
    `);
  }

  readonly createSession = async (
    scope: ProjectScope,
    request: CreateSessionRequest,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    scopeKey(scope);
    validateCreateSessionRequest(request);
    const key = scopeKey(scope);
    const existing = this.sessionRow(scope, request.sessionId);
    if (existing !== null) {
      const summary = summaryFromRow(existing);
      if (
        summary.runtimeId === request.runtimeId &&
        summary.agentId === request.agentId &&
        rowString(existing, "binding_id") === request.bindingId &&
        rowString(existing, "directory_id") === request.directoryId &&
        summary.policy.level === request.policy.level &&
        summary.policy.retentionMilliseconds ===
          request.policy.retentionMilliseconds &&
        summary.policy.hotEventLimit === request.policy.hotEventLimit &&
        summary.policy.contentLimitBytes === request.policy.contentLimitBytes
      ) {
        return summary;
      }
      throw new SessionRuntimeError(
        "session_conflict",
        "The session identifier is already in use",
      );
    }
    this.assertSessionQuota(scope);
    this.#database.run(
      `INSERT INTO session_records (
         scope_key, tenant_id, project_id, session_id, runtime_id, agent_id,
         binding_id, directory_id, title, recording_level,
         retention_milliseconds, hot_event_limit, content_limit_bytes,
         lifecycle, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        key,
        scope.tenantId,
        scope.projectId,
        request.sessionId,
        request.runtimeId,
        request.agentId,
        request.bindingId,
        request.directoryId,
        request.title,
        request.policy.level,
        request.policy.retentionMilliseconds,
        request.policy.hotEventLimit,
        request.policy.contentLimitBytes,
        now,
        now,
      ],
    );
    signal.throwIfAborted();
    return summaryFromRow(
      this.requireSessionRow(scope, request.sessionId, true),
    );
  };

  readonly acceptCommand = async (
    scope: ProjectScope,
    runtimeId: string,
    command: SessionPromptCommand,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionCommandAcceptance> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(runtimeId, "runtime");
    let validatedCommand: SessionPromptCommand;
    try {
      validatedCommand = decodeSessionPromptCommand(JSON.stringify(command));
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The session command is invalid",
        { cause },
      );
    }
    if (this.sessionRow(scope, validatedCommand.sessionId) === null) {
      await this.createSession(
        scope,
        new CreateSessionRequest(
          validatedCommand.sessionId,
          runtimeId,
          validatedCommand.agentId,
          validatedCommand.bindingId,
          validatedCommand.directoryId,
          {
            contentLimitBytes: DEFAULT_CONTENT_LIMIT_BYTES,
            hotEventLimit: DEFAULT_HOT_EVENT_LIMIT,
            level: "full",
            retentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
          },
        ),
        now,
        signal,
      );
    }
    const session = this.requireActiveSessionRow(
      scope,
      validatedCommand.sessionId,
      now,
    );
    if (rowString(session, "runtime_id") !== runtimeId) {
      throw new SessionRuntimeError(
        "session_access_denied",
        "The session is bound to another runtime",
      );
    }
    const key = scopeKey(scope);
    const encodedCommand = JSON.stringify(validatedCommand);
    return this.#database.transaction(() => {
      const duplicate = this.#database.query(
        `SELECT command_json, state FROM session_commands
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [key, validatedCommand.sessionId, validatedCommand.commandId],
      )[0];
      if (duplicate !== undefined) {
        if (rowString(duplicate, "command_json") !== encodedCommand) {
          throw new SessionRuntimeError(
            "session_conflict",
            "The command identifier was reused with different input",
          );
        }
        const state = rowString(duplicate, "state");
        if (
          state !== "accepted" &&
          state !== "running" &&
          state !== "completed" &&
          state !== "failed" &&
          state !== "outcome_unknown"
        ) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The command state is invalid",
          );
        }
        return { kind: "duplicate", state };
      }
      const active = this.#database.query(
        `SELECT command_id FROM session_commands
         WHERE scope_key = ? AND session_id = ?
           AND state IN ('accepted', 'running')
         LIMIT 1`,
        [key, validatedCommand.sessionId],
      )[0];
      if (active !== undefined) {
        throw new SessionRuntimeError(
          "session_busy",
          "The session already has an active command",
        );
      }
      this.#database.run(
        `INSERT INTO session_commands (
           scope_key, session_id, command_id, command_json, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
        [
          key,
          validatedCommand.sessionId,
          validatedCommand.commandId,
          encodedCommand,
          now,
          now,
        ],
      );
      this.#database.run(
        `UPDATE session_records SET updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [now, key, validatedCommand.sessionId],
      );
      return { kind: "accepted" };
    });
  };

  readonly commitEvent = async (
    scope: ProjectScope,
    runtimeId: string,
    envelope: SessionEventEnvelope,
    now: number,
    signal: AbortSignal,
  ): Promise<CommittedEventResult> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    let validatedEnvelope: SessionEventEnvelope;
    try {
      validatedEnvelope = decodeSessionEventEnvelope(
        encodeSessionEventEnvelope(envelope),
      );
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The session event envelope is invalid",
        { cause },
      );
    }
    const decoded = validateSessionEventEnvelope(validatedEnvelope);
    const session = this.requireActiveSessionRow(
      scope,
      validatedEnvelope.sessionId,
      now,
    );
    if (rowString(session, "runtime_id") !== runtimeId) {
      throw new SessionRuntimeError(
        "session_access_denied",
        "The session is bound to another runtime",
      );
    }
    const key = scopeKey(scope);
    const duplicate = this.#database.query(
      `SELECT sequence_number, event_id, payload, artifact_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ? AND event_id = ?`,
      [key, validatedEnvelope.sessionId, validatedEnvelope.eventId],
    )[0];
    if (duplicate !== undefined) {
      const payload = await this.readEventPayload(
        scope,
        validatedEnvelope.sessionId,
        duplicate,
        signal,
      );
      return {
        committed: committedFromRow(
          duplicate,
          scope,
          validatedEnvelope.sessionId,
          payload,
        ),
        duplicate: true,
      };
    }

    const prepared = this.prepareEvent(session, validatedEnvelope, decoded);
    const result = this.#database.transaction<CommittedSessionEvent>(() => {
      const freshSession = this.requireActiveSessionRow(
        scope,
        validatedEnvelope.sessionId,
        now,
      );
      this.assertArchiveCapacity(
        key,
        validatedEnvelope.sessionId,
        freshSession,
        prepared,
      );
      const sequence = rowNumber(freshSession, "next_sequence");
      this.applyEventProjection(
        key,
        validatedEnvelope.sessionId,
        prepared,
        now,
      );
      const eventArtifactId = `event-${validatedEnvelope.eventId}`;
      this.queueArchive(
        key,
        validatedEnvelope.sessionId,
        eventArtifactId,
        "event",
        validatedEnvelope.eventId,
        "application/json",
        prepared.payload,
      );
      if (prepared.activityDetail !== null) {
        this.queueArchive(
          key,
          validatedEnvelope.sessionId,
          prepared.activityDetail.artifactId,
          "activity",
          prepared.activityDetail.activityId,
          "application/json",
          prepared.activityDetail.payload,
        );
      }
      this.#database.run(
        `INSERT INTO session_events (
           scope_key, session_id, sequence_number, event_id, payload,
           artifact_id, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          validatedEnvelope.sessionId,
          sequence,
          validatedEnvelope.eventId,
          prepared.payload,
          eventArtifactId,
          now,
        ],
      );
      this.#database.run(
        `UPDATE session_records
         SET next_sequence = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [sequence + 1, now, key, validatedEnvelope.sessionId],
      );
      return {
        cursor: eventCursor(scope, validatedEnvelope.sessionId, sequence),
        eventId: validatedEnvelope.eventId,
        eventVersion: SESSION_EVENT_FORMAT_VERSION,
        kind: SESSION_EVENT_COMMITTED_KIND,
        payload: prepared.payload,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        recordedAt: new Date(now).toISOString(),
        sequence,
        sessionId: validatedEnvelope.sessionId,
      };
    });
    signal.throwIfAborted();
    return {
      committed: decodeCommittedSessionEvent(
        encodeCommittedSessionEvent(result),
      ),
      duplicate: false,
    };
  };

  readonly bindSession = async (
    scope: ProjectScope,
    sessionId: string,
    runtimeId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(runtimeId, "runtime");
    this.requireActiveSessionRow(scope, sessionId, Date.now());
    const active = this.#database.query(
      `SELECT command_id FROM session_commands
       WHERE scope_key = ? AND session_id = ?
         AND state IN ('accepted', 'running')
       LIMIT 1`,
      [scopeKey(scope), sessionId],
    )[0];
    if (active !== undefined) {
      throw new SessionRuntimeError(
        "session_busy",
        "The session cannot be rebound while an execution outcome is unresolved",
      );
    }
    this.#database.run(
      `UPDATE session_records SET runtime_id = ?, updated_at = ?
       WHERE scope_key = ? AND session_id = ?`,
      [runtimeId, Date.now(), scopeKey(scope), sessionId],
    );
    signal.throwIfAborted();
    return summaryFromRow(this.requireSessionRow(scope, sessionId, true));
  };

  readonly readSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    return summaryFromRow(
      this.requireActiveSessionRow(scope, sessionId, Date.now()),
    );
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
      `SELECT * FROM session_records
       WHERE scope_key = ? AND lifecycle = 'active' ${boundary}
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
              formatVersion: CURSOR_FORMAT_VERSION,
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
    const session = this.requireActiveSessionRow(scope, sessionId, Date.now());
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
      `SELECT sequence_number, event_id, payload, artifact_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ? AND sequence_number > ?
       ORDER BY sequence_number
       LIMIT ?`,
      [scopeKey(scope), sessionId, sequence, limit + 1],
    );
    const pageRows = rows.slice(0, limit);
    const events: CommittedSessionEvent[] = [];
    for (const row of pageRows) {
      const payload = await this.readEventPayload(
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
    this.requireActiveSessionRow(scope, sessionId, Date.now());
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
      `SELECT * FROM session_commands
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
              formatVersion: CURSOR_FORMAT_VERSION,
              projectId: scope.projectId,
              sessionId,
              tenantId: scope.tenantId,
            })
          : null,
    };
  };

  readonly readActivityDetail = async (
    scope: ProjectScope,
    sessionId: string,
    activityId: string,
    signal: AbortSignal,
  ): Promise<ActivityDetail> => {
    signal.throwIfAborted();
    validateDomainIdentifier(activityId, "activity");
    const session = this.sessionRow(scope, sessionId);
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
       FROM session_activities
       WHERE scope_key = ? AND session_id = ? AND activity_id = ?`,
      [scopeKey(scope), sessionId, activityId],
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
      hot ?? (await this.readArtifact(scope, sessionId, artifactId, signal));
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

  readonly markRuntimeDisconnected = async (
    scope: ProjectScope,
    runtimeId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<readonly CommittedSessionEvent[]> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(runtimeId, "runtime");
    this.#database.run(
      `UPDATE session_commands
       SET state = 'outcome_unknown', updated_at = ?
       WHERE scope_key = ? AND state = 'running'
         AND session_id IN (
           SELECT session_id FROM session_records
           WHERE scope_key = ? AND runtime_id = ? AND lifecycle = 'active'
         )`,
      [now, scopeKey(scope), scopeKey(scope), runtimeId],
    );
    return [];
  };

  readonly runArchiveWork = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<number> => {
    signal.throwIfAborted();
    this.requireSessionRow(scope, sessionId, false);
    const jobs = this.#database.query(
      `SELECT artifact_id, archive_kind, owner_id, media_type, hot_payload
       FROM session_archive_jobs
       WHERE scope_key = ? AND session_id = ?
       ORDER BY rowid
       LIMIT ?`,
      [scopeKey(scope), sessionId, MAX_ARCHIVE_BATCH_SIZE],
    );
    let completed = 0;
    for (const job of jobs) {
      signal.throwIfAborted();
      try {
        await this.archiveJob(scope, sessionId, job, signal);
        completed += 1;
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        this.#database.run(
          `UPDATE session_archive_jobs
           SET attempts = attempts + 1, last_error = ?
           WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
          [
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Archive upload failed",
            scopeKey(scope),
            sessionId,
            rowString(job, "artifact_id"),
          ],
        );
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The session archive could not be written",
          { cause: error },
        );
      }
    }
    await this.pruneArchivedEvents(scope, sessionId, signal);
    return completed;
  };

  readonly deleteSession = async (
    scope: ProjectScope,
    sessionId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionLifecycle> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    const session = this.requireSessionRow(scope, sessionId, false);
    const existingLifecycle = lifecycleFromRow(session);
    if (existingLifecycle.kind === "deleted") {
      return existingLifecycle;
    }
    if (existingLifecycle.kind === "active") {
      this.#database.run(
        `UPDATE session_records
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'active'`,
        [now, now, scopeKey(scope), sessionId],
      );
    }
    await this.deleteArchivedContent(scope, sessionId, signal);
    this.#database.transaction(() => {
      for (const table of [
        "session_archive_jobs",
        "session_archives",
        "session_activities",
        "session_events",
        "session_commands",
      ]) {
        this.#database.run(
          `DELETE FROM ${table} WHERE scope_key = ? AND session_id = ?`,
          [scopeKey(scope), sessionId],
        );
      }
      this.#database.run(
        `UPDATE session_records
         SET lifecycle = 'deleted', delete_completed_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [now, now, scopeKey(scope), sessionId],
      );
    });
    signal.throwIfAborted();
    return { completedAt: new Date(now).toISOString(), kind: "deleted" };
  };

  readonly exportSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionExport> => {
    signal.throwIfAborted();
    const sessionRow = this.requireActiveSessionRow(
      scope,
      sessionId,
      Date.now(),
    );
    const session = summaryFromRow(sessionRow);
    const eventRows = this.#database.query(
      `SELECT sequence_number, event_id, payload, artifact_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
       ORDER BY sequence_number`,
      [scopeKey(scope), sessionId],
    );
    const events: CommittedSessionEvent[] = [];
    let exportBytes = 0;
    for (const row of eventRows) {
      const payload = await this.readEventPayload(
        scope,
        sessionId,
        row,
        signal,
      );
      exportBytes += new TextEncoder().encode(payload).byteLength;
      if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
        throw new SessionRuntimeError(
          "content_too_large",
          "The session export exceeds the configured limit",
        );
      }
      events.push(committedFromRow(row, scope, sessionId, payload));
    }
    const commandRows = this.#database.query(
      `SELECT * FROM session_commands
       WHERE scope_key = ? AND session_id = ?
       ORDER BY created_at DESC, command_id DESC`,
      [scopeKey(scope), sessionId],
    );
    const commands: SessionExport["commands"][number][] = commandRows.map(
      (row) => {
        const encodedCommand = rowString(row, "command_json");
        const response = rowString(row, "response");
        exportBytes += new TextEncoder().encode(
          `${encodedCommand}${response}`,
        ).byteLength;
        if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
          throw new SessionRuntimeError(
            "content_too_large",
            "The session export exceeds the configured limit",
          );
        }
        let command: SessionPromptCommand;
        try {
          command = decodeSessionPromptCommand(encodedCommand);
        } catch (cause) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "A stored session command is invalid",
            { cause },
          );
        }
        return {
          command,
          createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
          response,
          state: this.attemptFromRow(row) ?? { kind: "accepted" },
          updatedAt: new Date(rowNumber(row, "updated_at")).toISOString(),
        };
      },
    );
    const activityRows = this.#database.query(
      `SELECT summary_json, event_sequence
       FROM session_activities
       WHERE scope_key = ? AND session_id = ?
       ORDER BY event_sequence, activity_id`,
      [scopeKey(scope), sessionId],
    );
    const activities: SessionExport["activities"][number][] = activityRows.map(
      (row) => {
        const encodedSummary = rowString(row, "summary_json");
        exportBytes += new TextEncoder().encode(encodedSummary).byteLength;
        if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
          throw new SessionRuntimeError(
            "content_too_large",
            "The session export exceeds the configured limit",
          );
        }
        const event = decodeRecordedSessionEvent(encodedSummary);
        if (event.kind !== AGENT_ACTIVITY_KIND) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "A stored session activity is invalid",
          );
        }
        return { event, eventSequence: rowNumber(row, "event_sequence") };
      },
    );
    const artifactRows = this.#database.query(
      `SELECT activity_id, detail_artifact_id, hot_detail
       FROM session_activities
       WHERE scope_key = ? AND session_id = ? AND detail_kind = 'available'
       ORDER BY activity_id`,
      [scopeKey(scope), sessionId],
    );
    const artifacts: SessionExport["artifacts"][number][] = [];
    for (const row of artifactRows) {
      const artifactId = rowNullableString(row, "detail_artifact_id");
      if (artifactId === null) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The activity archive reference is invalid",
        );
      }
      const hot = rowNullableString(row, "hot_detail");
      const encoded =
        hot ?? (await this.readArtifact(scope, sessionId, artifactId, signal));
      const bytes = new TextEncoder().encode(encoded);
      exportBytes += bytes.byteLength;
      if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
        throw new SessionRuntimeError(
          "content_too_large",
          "The session export exceeds the configured limit",
        );
      }
      artifacts.push({
        activityId: rowString(row, "activity_id"),
        artifactId,
        byteLength: bytes.byteLength,
        contentBase64: encodeBase64(bytes),
        contentEncoding: "identity",
        mediaType: "application/json",
        sha256: await sha256(bytes),
      });
    }
    return {
      activities,
      artifacts,
      bindingId: rowString(sessionRow, "binding_id"),
      commands,
      directoryId: rowString(sessionRow, "directory_id"),
      events,
      formatVersion: SESSION_EXPORT_FORMAT_VERSION,
      minimumSequence: rowNumber(sessionRow, "minimum_sequence"),
      nextSequence: rowNumber(sessionRow, "next_sequence"),
      session,
    };
  };

  readonly importSession = async (
    scope: ProjectScope,
    exported: unknown,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    if (
      !isRecord(exported) ||
      exported["formatVersion"] !== SESSION_EXPORT_FORMAT_VERSION ||
      !hasExactKeys(exported, [
        "activities",
        "artifacts",
        "bindingId",
        "commands",
        "directoryId",
        "events",
        "formatVersion",
        "minimumSequence",
        "nextSequence",
        "session",
      ])
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export is invalid",
      );
    }
    let encodedExport: string;
    try {
      encodedExport = JSON.stringify(exported);
    } catch (cause) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export is invalid",
        { cause },
      );
    }
    if (
      new TextEncoder().encode(encodedExport).byteLength >
      MAX_EXPORT_BYTE_LENGTH * 2
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export is too large",
      );
    }

    const importIdentifier = (
      value: Readonly<Record<string, unknown>>,
      key: string,
    ): string => {
      const identifier = this.importString(value, key, 128);
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        throw new SessionRuntimeError(
          "invalid_export",
          `The exported ${key} is invalid`,
        );
      }
      return identifier;
    };
    const importTimestamp = (
      value: Readonly<Record<string, unknown>>,
      key: string,
    ): number => {
      const timestamp = Date.parse(this.importString(value, key, 64));
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new SessionRuntimeError(
          "invalid_export",
          `The exported ${key} is invalid`,
        );
      }
      return timestamp;
    };

    const sourceSession = exported["session"];
    const eventValues = exported["events"];
    const commandValues = exported["commands"];
    const activityValues = exported["activities"];
    const artifactValues = exported["artifacts"];
    if (
      !isRecord(sourceSession) ||
      !Array.isArray(eventValues) ||
      !Array.isArray(commandValues) ||
      !Array.isArray(activityValues) ||
      !Array.isArray(artifactValues) ||
      eventValues.length > 100_000 ||
      commandValues.length > 10_000 ||
      activityValues.length > 100_000 ||
      artifactValues.length > 100_000
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export is invalid",
      );
    }
    if (
      !hasExactKeys(sourceSession, [
        "agentId",
        "createdAt",
        "lifecycle",
        "policy",
        "projectId",
        "runtimeId",
        "sessionId",
        "tenantId",
        "title",
        "updatedAt",
      ])
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported session descriptor is invalid",
      );
    }
    const lifecycle = sourceSession["lifecycle"];
    if (
      !isRecord(lifecycle) ||
      !hasExactKeys(lifecycle, ["kind"]) ||
      lifecycle["kind"] !== "active"
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "Only an active session can be imported",
      );
    }
    const sessionId = importIdentifier(sourceSession, "sessionId");
    const runtimeId = importIdentifier(sourceSession, "runtimeId");
    const agentId = importIdentifier(sourceSession, "agentId");
    importIdentifier(sourceSession, "tenantId");
    importIdentifier(sourceSession, "projectId");
    importTimestamp(sourceSession, "createdAt");
    importTimestamp(sourceSession, "updatedAt");
    const bindingId = importIdentifier(exported, "bindingId");
    const directoryId = importIdentifier(exported, "directoryId");
    const title = this.importString(sourceSession, "title", 500, true);
    const policy = sourceSession["policy"];
    if (
      !isRecord(policy) ||
      !hasExactKeys(policy, [
        "contentLimitBytes",
        "hotEventLimit",
        "level",
        "retentionMilliseconds",
      ])
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session policy is invalid",
      );
    }
    const level = policy["level"];
    const retentionMilliseconds = policy["retentionMilliseconds"];
    const hotEventLimit = policy["hotEventLimit"];
    const contentLimitBytes = policy["contentLimitBytes"];
    if (
      (level !== "full" && level !== "summary") ||
      typeof retentionMilliseconds !== "number" ||
      !Number.isSafeInteger(retentionMilliseconds) ||
      retentionMilliseconds < 60_000 ||
      retentionMilliseconds > 365 * 24 * 60 * 60 * 1_000 ||
      typeof hotEventLimit !== "number" ||
      !Number.isSafeInteger(hotEventLimit) ||
      hotEventLimit < 10 ||
      hotEventLimit > 10_000 ||
      typeof contentLimitBytes !== "number" ||
      !Number.isSafeInteger(contentLimitBytes) ||
      contentLimitBytes < 1_024 ||
      contentLimitBytes > DEFAULT_CONTENT_LIMIT_BYTES
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session policy is invalid",
      );
    }
    const minimumSequence = exported["minimumSequence"];
    const nextSequence = exported["nextSequence"];
    if (
      typeof minimumSequence !== "number" ||
      !Number.isSafeInteger(minimumSequence) ||
      minimumSequence < 1 ||
      typeof nextSequence !== "number" ||
      !Number.isSafeInteger(nextSequence) ||
      nextSequence < minimumSequence
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported event range is invalid",
      );
    }

    const events: CommittedSessionEvent[] = [];
    const decodedEvents = new Map<number, RecordedSessionEvent>();
    const eventIds = new Set<string>();
    let expectedSequence = minimumSequence;
    for (const value of eventValues) {
      let committed: CommittedSessionEvent;
      let decodedEvent: RecordedSessionEvent;
      try {
        committed = decodeCommittedSessionEvent(JSON.stringify(value));
        decodedEvent = decodeRecordedSessionEvent(committed.payload);
        if (decodedEvent.sessionId !== sessionId) {
          throw new Error("Event payload belongs to another session");
        }
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "The exported event stream is invalid",
          { cause },
        );
      }
      if (
        committed.sessionId !== sessionId ||
        committed.sequence !== expectedSequence ||
        eventIds.has(committed.eventId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "The exported event sequence is invalid",
        );
      }
      eventIds.add(committed.eventId);
      events.push(committed);
      decodedEvents.set(committed.sequence, decodedEvent);
      expectedSequence += 1;
    }
    if (expectedSequence !== nextSequence) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported event range is incomplete",
      );
    }

    const commands: ImportedCommand[] = [];
    const commandIds = new Set<string>();
    for (const value of commandValues) {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "command",
          "createdAt",
          "response",
          "state",
          "updatedAt",
        ])
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command is invalid",
        );
      }
      let command: SessionPromptCommand;
      try {
        command = decodeSessionPromptCommand(JSON.stringify(value["command"]));
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command is invalid",
          { cause },
        );
      }
      const createdAt = importTimestamp(value, "createdAt");
      const updatedAt = importTimestamp(value, "updatedAt");
      const response = this.importString(value, "response", 100_000, true);
      const stateValue = value["state"];
      if (
        command.sessionId !== sessionId ||
        commandIds.has(command.commandId) ||
        !isRecord(stateValue)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command is invalid",
        );
      }
      commandIds.add(command.commandId);
      let state: ImportedCommand["state"];
      let processAttemptId: string | null = null;
      let startedAt: number | null = null;
      let completedAt: number | null = null;
      let stopReason: string | null = null;
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      const kind = stateValue["kind"];
      if (kind === "accepted" && hasExactKeys(stateValue, ["kind"])) {
        state = "accepted";
      } else if (
        kind === "running" &&
        hasExactKeys(stateValue, ["kind", "processAttemptId", "startedAt"])
      ) {
        state = "running";
        processAttemptId = importIdentifier(stateValue, "processAttemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
      } else if (
        kind === "completed" &&
        hasExactKeys(stateValue, [
          "completedAt",
          "kind",
          "processAttemptId",
          "startedAt",
          "stopReason",
        ])
      ) {
        state = "completed";
        processAttemptId = importIdentifier(stateValue, "processAttemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
        completedAt = importTimestamp(stateValue, "completedAt");
        stopReason = this.importString(stateValue, "stopReason", 128, true);
      } else if (
        kind === "outcome_unknown" &&
        hasExactKeys(stateValue, [
          "disconnectedAt",
          "kind",
          "processAttemptId",
          "startedAt",
        ])
      ) {
        state = "outcome_unknown";
        processAttemptId = importIdentifier(stateValue, "processAttemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
      } else if (
        kind === "failed" &&
        hasExactKeys(stateValue, [
          "code",
          "failedAt",
          "kind",
          "message",
          "processAttemptId",
          "startedAt",
        ])
      ) {
        state = "failed";
        completedAt = importTimestamp(stateValue, "failedAt");
        errorCode = this.importString(stateValue, "code", 128);
        errorMessage = this.importString(stateValue, "message", 2_000, true);
        const processValue = stateValue["processAttemptId"];
        const startedValue = stateValue["startedAt"];
        if (processValue === null && startedValue === null) {
          processAttemptId = null;
          startedAt = null;
        } else if (
          typeof processValue === "string" &&
          typeof startedValue === "string"
        ) {
          processAttemptId = importIdentifier(stateValue, "processAttemptId");
          startedAt = importTimestamp(stateValue, "startedAt");
        } else {
          throw new SessionRuntimeError(
            "invalid_export",
            "An exported command attempt is invalid",
          );
        }
      } else {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command state is invalid",
        );
      }
      commands.push({
        command,
        completedAt,
        createdAt,
        errorCode,
        errorMessage,
        processAttemptId,
        response,
        startedAt,
        state,
        stopReason,
        updatedAt,
      });
    }
    for (const event of decodedEvents.values()) {
      if ("commandId" in event && !commandIds.has(event.commandId)) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported event references a missing command",
        );
      }
    }

    const activities: ImportedActivity[] = [];
    const activityIds = new Set<string>();
    for (const value of activityValues) {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ["event", "eventSequence"]) ||
        typeof value["eventSequence"] !== "number" ||
        !Number.isSafeInteger(value["eventSequence"]) ||
        value["eventSequence"] < 1 ||
        value["eventSequence"] >= nextSequence
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity is invalid",
        );
      }
      let event: RecordedSessionEvent;
      try {
        event = decodeRecordedSessionEvent(JSON.stringify(value["event"]));
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity is invalid",
          { cause },
        );
      }
      if (
        event.kind !== AGENT_ACTIVITY_KIND ||
        event.sessionId !== sessionId ||
        event.detail.kind === "recorded" ||
        !commandIds.has(event.commandId) ||
        activityIds.has(event.activityId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity is invalid",
        );
      }
      const retainedEvent = decodedEvents.get(value["eventSequence"]);
      if (
        retainedEvent !== undefined &&
        (retainedEvent.kind !== AGENT_ACTIVITY_KIND ||
          retainedEvent.activityId !== event.activityId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity does not match its retained event",
        );
      }
      activityIds.add(event.activityId);
      activities.push({ event, eventSequence: value["eventSequence"] });
    }

    const artifacts = new Map<
      string,
      { readonly activityId: string; readonly payload: string }
    >();
    let artifactBytes = 0;
    for (const value of artifactValues) {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "activityId",
          "artifactId",
          "byteLength",
          "contentBase64",
          "contentEncoding",
          "mediaType",
          "sha256",
        ])
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An export artifact is invalid",
        );
      }
      const activityId = importIdentifier(value, "activityId");
      const artifactId = importIdentifier(value, "artifactId");
      const mediaType = this.importString(value, "mediaType", 128);
      const contentBase64 = this.importString(
        value,
        "contentBase64",
        MAX_EXPORT_BYTE_LENGTH * 2,
        true,
      );
      const expectedHash = this.importString(value, "sha256", 64);
      const byteLength = value["byteLength"];
      if (
        mediaType !== "application/json" ||
        value["contentEncoding"] !== "identity" ||
        typeof byteLength !== "number" ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        artifacts.has(artifactId) ||
        !activityIds.has(activityId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An export artifact is invalid",
        );
      }
      let bytes: Uint8Array;
      let payload: string;
      try {
        bytes = decodeBase64(contentBase64);
        payload = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes);
        decodeActivityDetailPayload(
          payload,
          "invalid_export",
          "An export artifact is invalid",
        );
      } catch (cause) {
        if (
          cause instanceof SessionRuntimeError &&
          cause.code === "invalid_export"
        ) {
          throw cause;
        }
        throw new SessionRuntimeError(
          "invalid_export",
          "An export artifact is invalid",
          { cause },
        );
      }
      artifactBytes += bytes.byteLength;
      if (
        bytes.byteLength !== byteLength ||
        bytes.byteLength > contentLimitBytes ||
        artifactBytes > MAX_EXPORT_BYTE_LENGTH ||
        !/^[a-f0-9]{64}$/.test(expectedHash) ||
        (await sha256(bytes)) !== expectedHash
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An export artifact is invalid",
        );
      }
      artifacts.set(artifactId, { activityId, payload });
    }
    const referencedArtifacts = new Set<string>();
    for (const activity of activities) {
      if (activity.event.detail.kind !== "available") {
        continue;
      }
      const artifact = artifacts.get(activity.event.detail.artifactId);
      if (artifact?.activityId !== activity.event.activityId) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An activity archive is missing from the export",
        );
      }
      referencedArtifacts.add(activity.event.detail.artifactId);
    }
    if (
      [...artifacts.keys()].some(
        (artifactId) => !referencedArtifacts.has(artifactId),
      )
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export contains an unreferenced artifact",
      );
    }

    if (this.sessionRow(scope, sessionId) !== null) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The imported session identifier is already in use",
      );
    }
    const key = scopeKey(scope);
    let created = false;
    try {
      await this.createSession(
        scope,
        new CreateSessionRequest(
          sessionId,
          runtimeId,
          agentId,
          bindingId,
          directoryId,
          { contentLimitBytes, hotEventLimit, level, retentionMilliseconds },
          title,
        ),
        now,
        signal,
      );
      created = true;
      signal.throwIfAborted();
      this.#database.transaction(() => {
        for (const command of commands) {
          this.#database.run(
            `INSERT INTO session_commands (
               scope_key, session_id, command_id, command_json, state,
               response, process_attempt_id, started_at, completed_at,
               stop_reason, error_code, error_message, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              command.command.commandId,
              JSON.stringify(command.command),
              command.state,
              command.response,
              command.processAttemptId,
              command.startedAt,
              command.completedAt,
              command.stopReason,
              command.errorCode,
              command.errorMessage,
              command.createdAt,
              command.updatedAt,
            ],
          );
        }
        for (const activity of activities) {
          const detail = activity.event.detail;
          const artifactId =
            detail.kind === "available" ? detail.artifactId : null;
          const artifact =
            artifactId === null ? undefined : artifacts.get(artifactId);
          this.#database.run(
            `INSERT INTO session_activities (
               scope_key, session_id, command_id, activity_id, summary_json,
               detail_kind, detail_artifact_id, hot_detail, captured_bytes,
               original_bytes, event_sequence
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              activity.event.commandId,
              activity.event.activityId,
              encodeAgentActivityEvent(activity.event),
              detail.kind,
              artifactId,
              artifact?.payload ?? null,
              detail.kind === "truncated" ? detail.capturedBytes : 0,
              detail.kind === "truncated" ? detail.originalBytes : 0,
              activity.eventSequence,
            ],
          );
          if (artifactId !== null && artifact !== undefined) {
            this.queueArchive(
              key,
              sessionId,
              artifactId,
              "activity",
              activity.event.activityId,
              "application/json",
              artifact.payload,
            );
          }
        }
        for (const committed of events) {
          const eventArtifactId = `event-${committed.eventId}`;
          if (artifacts.has(eventArtifactId)) {
            throw new SessionRuntimeError(
              "invalid_export",
              "An exported artifact identifier collides with an event",
            );
          }
          this.queueArchive(
            key,
            sessionId,
            eventArtifactId,
            "event",
            committed.eventId,
            "application/json",
            committed.payload,
          );
          this.#database.run(
            `INSERT INTO session_events (
               scope_key, session_id, sequence_number, event_id, payload,
               artifact_id, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              committed.sequence,
              committed.eventId,
              committed.payload,
              eventArtifactId,
              Date.parse(committed.recordedAt),
            ],
          );
        }
        this.#database.run(
          `UPDATE session_records
           SET minimum_sequence = ?, next_sequence = ?, updated_at = ?
           WHERE scope_key = ? AND session_id = ?`,
          [minimumSequence, nextSequence, now, key, sessionId],
        );
      });
      signal.throwIfAborted();
    } catch (error) {
      if (created) {
        this.#database.transaction(() => {
          for (const table of [
            "session_archive_jobs",
            "session_archives",
            "session_activities",
            "session_events",
            "session_commands",
            "session_records",
          ]) {
            this.#database.run(
              `DELETE FROM ${table} WHERE scope_key = ? AND session_id = ?`,
              [key, sessionId],
            );
          }
        });
      }
      throw error;
    }
    return summaryFromRow(this.requireActiveSessionRow(scope, sessionId, now));
  };

  readonly hasPendingArchiveWork = (
    scope: ProjectScope,
    sessionId: string,
  ): boolean =>
    this.#database.query(
      `SELECT artifact_id FROM session_archive_jobs
       WHERE scope_key = ? AND session_id = ? LIMIT 1`,
      [scopeKey(scope), sessionId],
    )[0] !== undefined;

  private readonly assertSessionQuota = (scope: ProjectScope): void => {
    const tenant = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM session_records
       WHERE tenant_id = ? AND lifecycle <> 'deleted'`,
      [scope.tenantId],
    )[0];
    const project = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM session_records
       WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'`,
      [scope.tenantId, scope.projectId],
    )[0];
    if (tenant === undefined || project === undefined) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The session quota usage is unavailable",
      );
    }
    if (
      rowNumber(tenant, "active_sessions") >=
        this.#quota.activeSessionsPerTenant ||
      rowNumber(project, "active_sessions") >=
        this.#quota.activeSessionsPerProject
    ) {
      throw new SessionRuntimeError(
        "session_quota_exceeded",
        "The tenant or project active session quota is exhausted",
      );
    }
  };

  private readonly sessionRow = (
    scope: ProjectScope,
    sessionId: string,
  ): SessionSqlRow | null => {
    validateDomainIdentifier(sessionId, "session");
    return (
      this.#database.query(
        `SELECT * FROM session_records
       WHERE scope_key = ? AND session_id = ?`,
        [scopeKey(scope), sessionId],
      )[0] ?? null
    );
  };

  private readonly requireSessionRow = (
    scope: ProjectScope,
    sessionId: string,
    activeOnly: boolean,
  ): SessionSqlRow => {
    const row = this.sessionRow(scope, sessionId);
    if (row === null) {
      throw new SessionRuntimeError(
        "session_not_found",
        "The session does not exist",
      );
    }
    if (activeOnly && rowString(row, "lifecycle") !== "active") {
      throw new SessionRuntimeError(
        "session_deleted",
        "The session is being deleted or has been deleted",
      );
    }
    return row;
  };

  private readonly requireActiveSessionRow = (
    scope: ProjectScope,
    sessionId: string,
    now: number,
  ): SessionSqlRow => {
    const row = this.requireSessionRow(scope, sessionId, true);
    const expiresAt =
      rowNumber(row, "updated_at") + rowNumber(row, "retention_milliseconds");
    if (now >= expiresAt) {
      this.#database.run(
        `UPDATE session_records
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'active'`,
        [now, now, scopeKey(scope), sessionId],
      );
      throw new SessionRuntimeError(
        "session_deleted",
        "The session retention period has expired",
      );
    }
    return row;
  };

  private readonly prepareEvent = (
    session: SessionSqlRow,
    envelope: SessionEventEnvelope,
    event: RecordedSessionEvent,
  ): PreparedEvent => {
    if (event.kind !== AGENT_ACTIVITY_KIND) {
      return { activityDetail: null, event, payload: envelope.payload };
    }
    if (event.detail.kind === "available") {
      throw new SessionRuntimeError(
        "session_conflict",
        "A daemon cannot submit an archive reference",
      );
    }
    if (event.detail.kind === "recorded") {
      const detailPayload = JSON.stringify({
        content: event.detail.content,
        input: event.detail.input,
        output: event.detail.output,
      });
      const originalBytes = new TextEncoder().encode(detailPayload).byteLength;
      if (rowString(session, "recording_level") === "summary") {
        const summarized: AgentActivityEvent = {
          ...event,
          detail: { kind: "unrecorded" },
        };
        return {
          activityDetail: null,
          event: summarized,
          payload: encodeAgentActivityEvent(summarized),
        };
      }
      if (originalBytes > rowNumber(session, "content_limit_bytes")) {
        const summarized: AgentActivityEvent = {
          ...event,
          detail: { capturedBytes: 0, kind: "truncated", originalBytes },
        };
        return {
          activityDetail: null,
          event: summarized,
          payload: encodeAgentActivityEvent(summarized),
        };
      }
      const artifactId = `activity-${envelope.eventId}`;
      const summarized: AgentActivityEvent = {
        ...event,
        detail: { artifactId, kind: "available" },
      };
      return {
        activityDetail: {
          activityId: event.activityId,
          artifactId,
          payload: detailPayload,
        },
        event: summarized,
        payload: encodeAgentActivityEvent(summarized),
      };
    }
    return {
      activityDetail: null,
      event,
      payload: encodeAgentActivityEvent(event),
    };
  };

  private readonly requireCommandState = (
    key: string,
    sessionId: string,
    commandId: string,
    states: readonly string[],
  ): SessionSqlRow => {
    const row = this.#database.query(
      `SELECT * FROM session_commands
       WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
      [key, sessionId, commandId],
    )[0];
    if (row === undefined || !states.includes(rowString(row, "state"))) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The event does not match the current command state",
      );
    }
    return row;
  };

  private readonly applyEventProjection = (
    key: string,
    sessionId: string,
    prepared: PreparedEvent,
    now: number,
  ): void => {
    const event = prepared.event;
    if (event.kind === SESSION_STARTED_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, ["accepted"]);
      this.#database.run(
        `UPDATE session_commands
         SET state = 'running', process_attempt_id = ?, started_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [event.processAttemptId, now, now, key, sessionId, event.commandId],
      );
      return;
    }
    if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, ["running"]);
      this.#database.run(
        `UPDATE session_commands
         SET response = substr(response || ?, 1, 100000), updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [event.text, now, key, sessionId, event.commandId],
      );
      return;
    }
    if (event.kind === AGENT_ACTIVITY_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, ["running"]);
      const sequenceRow = this.#database.query(
        `SELECT next_sequence FROM session_records
         WHERE scope_key = ? AND session_id = ?`,
        [key, sessionId],
      )[0];
      if (sequenceRow === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The session state is unavailable",
        );
      }
      const detail = event.detail;
      const detailArtifactId =
        detail.kind === "available" ? detail.artifactId : null;
      const hotDetail = prepared.activityDetail?.payload ?? null;
      const capturedBytes =
        detail.kind === "truncated" ? detail.capturedBytes : 0;
      const originalBytes =
        detail.kind === "truncated" ? detail.originalBytes : 0;
      const detailKind =
        detail.kind === "available"
          ? "available"
          : detail.kind === "truncated"
            ? "truncated"
            : "unrecorded";
      this.#database.run(
        `INSERT INTO session_activities (
           scope_key, session_id, command_id, activity_id, summary_json,
           detail_kind, detail_artifact_id, hot_detail, captured_bytes,
           original_bytes, event_sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, session_id, activity_id) DO UPDATE SET
           command_id = excluded.command_id,
           summary_json = excluded.summary_json,
           detail_kind = excluded.detail_kind,
           detail_artifact_id = excluded.detail_artifact_id,
           hot_detail = excluded.hot_detail,
           captured_bytes = excluded.captured_bytes,
           original_bytes = excluded.original_bytes,
           event_sequence = excluded.event_sequence`,
        [
          key,
          sessionId,
          event.commandId,
          event.activityId,
          encodeAgentActivityEvent(event),
          detailKind,
          detailArtifactId,
          hotDetail,
          capturedBytes,
          originalBytes,
          rowNumber(sequenceRow, "next_sequence"),
        ],
      );
      return;
    }
    if (event.kind === SESSION_COMPLETED_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, ["running"]);
      this.#database.run(
        `UPDATE session_commands
         SET state = 'completed', completed_at = ?, stop_reason = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [now, event.stopReason, now, key, sessionId, event.commandId],
      );
      return;
    }
    if (event.kind === SESSION_FAILED_KIND) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["accepted", "running"],
      );
      this.#database.run(
        `UPDATE session_commands
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [
          now,
          event.code,
          event.message,
          now,
          key,
          sessionId,
          rowString(command, "command_id"),
        ],
      );
      return;
    }
    if (event.kind === SESSION_INFO_UPDATED_KIND) {
      this.#database.run(
        `UPDATE session_records SET title = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [event.title ?? "", now, key, sessionId],
      );
    }
  };

  private readonly assertArchiveCapacity = (
    key: string,
    sessionId: string,
    session: SessionSqlRow,
    prepared: PreparedEvent,
  ): void => {
    const backlog = this.#database.query(
      `SELECT COUNT(*) AS pending_jobs,
              COALESCE(SUM(length(CAST(hot_payload AS BLOB))), 0) AS pending_bytes
       FROM session_archive_jobs
       WHERE scope_key = ? AND session_id = ?`,
      [key, sessionId],
    )[0];
    if (backlog === undefined) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The session archive backlog is unavailable",
      );
    }
    const incomingPayloads = [
      prepared.payload,
      ...(prepared.activityDetail === null
        ? []
        : [prepared.activityDetail.payload]),
    ];
    const incomingBytes = incomingPayloads.reduce(
      (total, payload) => total + new TextEncoder().encode(payload).byteLength,
      0,
    );
    const byteLimit = Math.min(
      MAX_PENDING_ARCHIVE_BYTE_LIMIT,
      Math.max(
        MIN_PENDING_ARCHIVE_BYTE_LIMIT,
        rowNumber(session, "content_limit_bytes") * 4,
      ),
    );
    const jobLimit = Math.max(20, rowNumber(session, "hot_event_limit") * 2);
    if (
      rowNumber(backlog, "pending_jobs") + incomingPayloads.length > jobLimit ||
      rowNumber(backlog, "pending_bytes") + incomingBytes > byteLimit
    ) {
      throw new SessionRuntimeError(
        "session_busy",
        "The session archive backlog is full; event ingestion is paused until archiving recovers",
      );
    }
  };

  private readonly queueArchive = (
    key: string,
    sessionId: string,
    artifactId: string,
    archiveKind: "activity" | "event",
    ownerId: string,
    mediaType: string,
    hotPayload: string,
  ): void => {
    const bytes = new TextEncoder().encode(hotPayload);
    this.#database.run(
      `INSERT INTO session_archives (
         scope_key, session_id, artifact_id, archive_kind, owner_id,
         media_type, byte_length, sha256, segments_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL)
       ON CONFLICT(scope_key, session_id, artifact_id) DO NOTHING`,
      [
        key,
        sessionId,
        artifactId,
        archiveKind,
        ownerId,
        mediaType,
        bytes.byteLength,
      ],
    );
    this.#database.run(
      `INSERT INTO session_archive_jobs (
         scope_key, session_id, artifact_id, archive_kind, owner_id,
         media_type, hot_payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, session_id, artifact_id) DO NOTHING`,
      [key, sessionId, artifactId, archiveKind, ownerId, mediaType, hotPayload],
    );
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
      `SELECT summary_json, detail_kind
       FROM session_activities
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
        activityType: event.activityType,
        detailAvailability,
        input: event.input,
        locations: event.locations,
        name: event.name,
        output: event.output,
        sequence: event.sequence,
        status: event.status,
        title: event.title,
        toolKind: event.toolKind,
      };
    });
    return {
      activities,
      agentId: command.agentId,
      attempt: this.attemptFromRow(row),
      commandId: command.commandId,
      createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
      prompt: command.prompt,
      response: rowString(row, "response"),
      sessionId,
    };
  };

  private readonly attemptFromRow = (
    row: SessionSqlRow,
  ): AttemptSummary | null => {
    const state = rowString(row, "state");
    if (state === "accepted") {
      return null;
    }
    const processAttemptId = rowNullableString(row, "process_attempt_id");
    const startedAtValue = Reflect.get(row, "started_at");
    const startedAt =
      typeof startedAtValue === "number"
        ? new Date(startedAtValue).toISOString()
        : null;
    if (state === "failed") {
      const failedAt = Reflect.get(row, "completed_at");
      return {
        code: rowNullableString(row, "error_code") ?? "session_failed",
        failedAt: new Date(
          typeof failedAt === "number"
            ? failedAt
            : rowNumber(row, "updated_at"),
        ).toISOString(),
        kind: "failed",
        message:
          rowNullableString(row, "error_message") ?? "The session failed",
        processAttemptId,
        startedAt,
      };
    }
    if (processAttemptId === null || startedAt === null) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The stored attempt is incomplete",
      );
    }
    if (state === "running") {
      return { kind: "running", processAttemptId, startedAt };
    }
    if (state === "outcome_unknown") {
      return {
        disconnectedAt: new Date(rowNumber(row, "updated_at")).toISOString(),
        kind: "outcome_unknown",
        processAttemptId,
        startedAt,
      };
    }
    if (state === "completed") {
      const completedAt = Reflect.get(row, "completed_at");
      if (typeof completedAt !== "number") {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The stored completion is incomplete",
        );
      }
      return {
        completedAt: new Date(completedAt).toISOString(),
        kind: "completed",
        processAttemptId,
        startedAt,
        stopReason: rowNullableString(row, "stop_reason") ?? "unknown",
      };
    }
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored command state is invalid",
    );
  };

  private readonly archiveJob = async (
    scope: ProjectScope,
    sessionId: string,
    job: SessionSqlRow,
    signal: AbortSignal,
  ): Promise<void> => {
    const artifactId = rowString(job, "artifact_id");
    const payload = rowString(job, "hot_payload");
    const mediaType = rowString(job, "media_type");
    const bytes = new TextEncoder().encode(payload);
    const segments: ArchiveSegment[] = [];
    const segmentCount = Math.max(
      1,
      Math.ceil(bytes.byteLength / ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT),
    );
    for (let index = 0; index < segmentCount; index += 1) {
      signal.throwIfAborted();
      const start = index * ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT;
      const uncompressed = bytes.slice(
        start,
        Math.min(bytes.byteLength, start + ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT),
      );
      const compressed = await gzip(uncompressed, signal);
      if (compressed.byteLength > ARCHIVE_SEGMENT_BYTE_LIMIT) {
        throw new SessionRuntimeError(
          "content_too_large",
          "A compressed archive segment exceeds the configured limit",
        );
      }
      const segmentId = `${artifactId}.${index.toString().padStart(6, "0")}`;
      const digest = await sha256(compressed);
      await this.#content.write(
        new ContentTarget(
          scope.tenantId,
          scope.projectId,
          sessionId,
          segmentId,
        ),
        {
          bytes: compressed,
          contentEncoding: "gzip",
          mediaType,
          sha256: digest,
        },
        signal,
      );
      segments.push({
        artifactId: segmentId,
        byteLength: uncompressed.byteLength,
        sha256: digest,
        storedByteLength: compressed.byteLength,
      });
    }
    const digest = await sha256(bytes);
    this.#database.transaction(() => {
      const current = this.#database.query(
        `SELECT artifact_id FROM session_archive_jobs
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
        [scopeKey(scope), sessionId, artifactId],
      )[0];
      if (current === undefined) {
        return;
      }
      this.#database.run(
        `UPDATE session_archives
         SET byte_length = ?, sha256 = ?, segments_json = ?
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
        [
          bytes.byteLength,
          digest,
          JSON.stringify(segments),
          scopeKey(scope),
          sessionId,
          artifactId,
        ],
      );
      this.#database.run(
        `DELETE FROM session_archive_jobs
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
        [scopeKey(scope), sessionId, artifactId],
      );
      if (rowString(job, "archive_kind") === "event") {
        this.#database.run(
          `UPDATE session_events SET payload = NULL
           WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
          [scopeKey(scope), sessionId, artifactId],
        );
      } else {
        this.#database.run(
          `UPDATE session_activities SET hot_detail = NULL
           WHERE scope_key = ? AND session_id = ? AND detail_artifact_id = ?`,
          [scopeKey(scope), sessionId, artifactId],
        );
      }
    });
  };

  private readonly readArtifact = async (
    scope: ProjectScope,
    sessionId: string,
    artifactId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const row = this.#database.query(
      `SELECT byte_length, sha256, segments_json FROM session_archives
       WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
      [scopeKey(scope), sessionId, artifactId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "artifact_not_found",
        "The archive does not exist",
      );
    }
    const segmentsJson = rowNullableString(row, "segments_json");
    if (segmentsJson === null) {
      const pending = this.#database.query(
        `SELECT hot_payload FROM session_archive_jobs
         WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
        [scopeKey(scope), sessionId, artifactId],
      )[0];
      if (pending !== undefined) {
        return rowString(pending, "hot_payload");
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive manifest is not committed",
      );
    }
    const segments = parseSegments(segmentsJson);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (const segment of segments) {
        signal.throwIfAborted();
        const content = await this.#content.read(
          new ContentTarget(
            scope.tenantId,
            scope.projectId,
            sessionId,
            segment.artifactId,
          ),
          signal,
        );
        if (
          content.bytes.byteLength !== segment.storedByteLength ||
          content.sha256 !== segment.sha256 ||
          (await sha256(content.bytes)) !== segment.sha256
        ) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "An archive segment failed integrity validation",
          );
        }
        const chunk = await gunzip(content.bytes, signal);
        if (chunk.byteLength !== segment.byteLength) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "An archive segment has an invalid length",
          );
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } catch (error) {
      if (signal.aborted || error instanceof SessionRuntimeError) {
        throw error;
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive could not be read",
        { cause: error },
      );
    }
    if (total !== rowNumber(row, "byte_length")) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive has an invalid length",
      );
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if ((await sha256(bytes)) !== rowString(row, "sha256")) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive failed integrity validation",
      );
    }
    return new TextDecoder().decode(bytes);
  };

  private readonly readEventPayload = async (
    scope: ProjectScope,
    sessionId: string,
    row: SessionSqlRow,
    signal: AbortSignal,
  ): Promise<string> => {
    const payload = rowNullableString(row, "payload");
    return (
      payload ??
      (await this.readArtifact(
        scope,
        sessionId,
        rowString(row, "artifact_id"),
        signal,
      ))
    );
  };

  private readonly pruneArchivedEvents = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const session = this.requireSessionRow(scope, sessionId, false);
    if (rowString(session, "lifecycle") !== "active") {
      return;
    }
    const capacity = rowNumber(session, "hot_event_limit") * 4;
    const countRow = this.#database.query(
      `SELECT COUNT(*) AS event_count FROM session_events
       WHERE scope_key = ? AND session_id = ?`,
      [scopeKey(scope), sessionId],
    )[0];
    if (countRow === undefined) {
      return;
    }
    const excess = rowNumber(countRow, "event_count") - capacity;
    if (excess <= 0) {
      return;
    }
    const rows = this.#database.query(
      `SELECT e.sequence_number, e.artifact_id, a.segments_json
       FROM session_events e
       JOIN session_archives a
         ON a.scope_key = e.scope_key
        AND a.session_id = e.session_id
        AND a.artifact_id = e.artifact_id
       WHERE e.scope_key = ? AND e.session_id = ?
         AND e.payload IS NULL AND a.segments_json IS NOT NULL
       ORDER BY e.sequence_number
       LIMIT ?`,
      [scopeKey(scope), sessionId, excess],
    );
    let highestDeletedSequence = 0;
    for (const row of rows) {
      signal.throwIfAborted();
      await this.deleteManifestSegments(scope, sessionId, row, signal);
      const sequence = rowNumber(row, "sequence_number");
      this.#database.transaction(() => {
        this.#database.run(
          `DELETE FROM session_events
           WHERE scope_key = ? AND session_id = ? AND sequence_number = ?`,
          [scopeKey(scope), sessionId, sequence],
        );
        this.#database.run(
          `DELETE FROM session_archives
           WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
          [scopeKey(scope), sessionId, rowString(row, "artifact_id")],
        );
      });
      highestDeletedSequence = sequence;
    }
    if (highestDeletedSequence > 0) {
      this.#database.run(
        `UPDATE session_records SET minimum_sequence = ?
         WHERE scope_key = ? AND session_id = ?`,
        [highestDeletedSequence + 1, scopeKey(scope), sessionId],
      );
    }
  };

  private readonly deleteArchivedContent = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const manifests = this.#database.query(
      `SELECT artifact_id, segments_json FROM session_archives
       WHERE scope_key = ? AND session_id = ? AND segments_json IS NOT NULL`,
      [scopeKey(scope), sessionId],
    );
    for (const manifest of manifests) {
      await this.deleteManifestSegments(scope, sessionId, manifest, signal);
    }
    const pending = this.#database.query(
      `SELECT artifact_id, hot_payload FROM session_archive_jobs
       WHERE scope_key = ? AND session_id = ?`,
      [scopeKey(scope), sessionId],
    );
    for (const job of pending) {
      const bytes = new TextEncoder().encode(rowString(job, "hot_payload"));
      const count = Math.max(
        1,
        Math.ceil(bytes.byteLength / ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT),
      );
      for (let index = 0; index < count; index += 1) {
        signal.throwIfAborted();
        await this.deleteContent(
          scope,
          sessionId,
          `${rowString(job, "artifact_id")}.${index.toString().padStart(6, "0")}`,
          signal,
        );
      }
    }
  };

  private readonly deleteManifestSegments = async (
    scope: ProjectScope,
    sessionId: string,
    manifest: SessionSqlRow,
    signal: AbortSignal,
  ): Promise<void> => {
    const encoded = rowNullableString(manifest, "segments_json");
    if (encoded === null) {
      return;
    }
    for (const segment of parseSegments(encoded)) {
      await this.deleteContent(scope, sessionId, segment.artifactId, signal);
    }
  };

  private readonly deleteContent = async (
    scope: ProjectScope,
    sessionId: string,
    artifactId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      await this.#content.delete(
        new ContentTarget(
          scope.tenantId,
          scope.projectId,
          sessionId,
          artifactId,
        ),
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (
        error instanceof ContentStorageError &&
        error.code === "content_not_found"
      ) {
        return;
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archived content could not be deleted",
        { cause: error },
      );
    }
  };

  private readonly importString = (
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty = false,
  ): string => {
    const field = value[key];
    if (
      typeof field !== "string" ||
      field.length > maximumLength ||
      (!allowEmpty && field.length === 0)
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        `The exported ${key} is invalid`,
      );
    }
    return field;
  };
}
