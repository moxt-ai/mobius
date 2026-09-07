import {
  AGENT_ACTIVITY_KIND,
  AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT,
  AGENT_ACTIVITY_RECORDED_FIELD_LIMIT,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  type Attempt,
  type CommandReceipt,
  type CommittedSessionEvent,
  decodeCommandReceipt,
  decodeCommittedSessionEvent,
  decodeInteraction,
  decodeInteractionRequest,
  decodeInteractionResponse,
  decodeNativeSessionHistory,
  decodeRecordedAgentContentValue,
  decodeRecordedSessionEvent,
  decodeSessionBinding,
  decodeSessionEventEnvelope,
  decodeSessionPromptCommand,
  decodeTurn,
  encodeAgentActivityEvent,
  encodeCommittedSessionEvent,
  encodeSessionEventEnvelope,
  type Interaction,
  type InteractionResponse,
  type NativeSessionHistory,
  type PendingWork,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIG_UPDATED_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_ELICITATION_RESOLVED_KIND,
  SESSION_EVENT_COMMITTED_KIND,
  SESSION_FAILED_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PERMISSION_RESOLVED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionBinding,
  type SessionEventEnvelope,
  type SessionPromptCommand,
  type Turn,
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
  type CreateSessionBindingRequest,
  CreateSessionRequest,
  DEFAULT_SESSION_QUOTA_POLICY,
  type InteractionResponseAcceptance,
  type PendingDaemonDelivery,
  type ProjectScope,
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
  type TurnAcceptance,
} from "./session-runtime.ts";

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
const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;

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
  readonly projectId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly tenantId: string;
}

interface MessageCursor {
  readonly commandId: string;
  readonly createdAt: number;
  readonly projectId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

interface DirectoryCursor {
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
  readonly bindingId: string;
  readonly command: SessionPromptCommand;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly idempotencyKey: string;
  readonly attemptId: string | null;
  readonly requestHash: string;
  readonly response: string;
  readonly startedAt: number | null;
  readonly state:
    | "cancelled"
    | "failed"
    | "indeterminate"
    | "queued"
    | "running"
    | "succeeded";
  readonly stopReason: string | null;
  readonly turnId: string;
  readonly updatedAt: number;
}

interface ImportedActivity {
  readonly attemptId: string;
  readonly event: AgentActivityEvent;
  readonly eventSequence: number;
}

interface StoredArchiveChunk {
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
  validateDomainIdentifier(request.createdBy, "creator");
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
    request.policy.idempotencyRetentionMilliseconds < 60_000 ||
    request.policy.idempotencyRetentionMilliseconds >
      request.policy.retentionMilliseconds ||
    !Number.isSafeInteger(request.policy.idempotencyRetentionMilliseconds) ||
    (request.policy.level !== "full" && request.policy.level !== "summary") ||
    !Number.isSafeInteger(request.binding.configRevision) ||
    request.binding.configRevision < 0
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
    !hasExactKeys(value, ["projectId", "sequence", "sessionId", "tenantId"]) ||
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
    !hasExactKeys(value, [
      "commandId",
      "createdAt",
      "projectId",
      "sessionId",
      "tenantId",
    ]) ||
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
    !hasExactKeys(value, ["projectId", "sessionId", "tenantId", "updatedAt"]) ||
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
  if (lifecycle === "ready") {
    return { kind: "ready" };
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
  const createdAt = new Date(rowNumber(row, "created_at")).toISOString();
  return {
    agentId: rowString(row, "agent_id"),
    createdAt,
    createdBy: rowString(row, "created_by"),
    defaultBinding: {
      agentRef: rowString(row, "agent_id"),
      bindingId: rowString(row, "binding_id"),
      configRevision: rowNumber(row, "config_revision"),
      createdAt: new Date(rowNumber(row, "binding_created_at")).toISOString(),
      runtimeId: rowString(row, "runtime_id"),
      sessionId: rowString(row, "session_id"),
      workspaceRef: rowString(row, "directory_id"),
    },
    hasNativeHistory: rowNullableString(row, "native_history_json") !== null,
    lastCommittedSeq: (rowNumber(row, "next_sequence") - 1).toString(),
    lifecycle: lifecycleFromRow(row),
    policy: {
      contentLimitBytes: rowNumber(row, "content_limit_bytes"),
      hotEventLimit: rowNumber(row, "hot_event_limit"),
      idempotencyRetentionMilliseconds: rowNumber(
        row,
        "idempotency_retention_milliseconds",
      ),
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

function bindingFromRow(row: SessionSqlRow): SessionBinding {
  return decodeSessionBinding({
    agentRef: rowString(row, "agent_ref"),
    bindingId: rowString(row, "binding_id"),
    configRevision: rowNumber(row, "config_revision"),
    createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
    runtimeId: rowString(row, "runtime_id"),
    sessionId: rowString(row, "session_id"),
    workspaceRef: rowString(row, "workspace_ref"),
  });
}

function eventCursor(
  scope: ProjectScope,
  sessionId: string,
  sequence: number,
): string {
  return encodeCursor({
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
      kind: SESSION_EVENT_COMMITTED_KIND,
      payload,
      recordedAt: new Date(rowNumber(row, "recorded_at")).toISOString(),
      sequence: rowNumber(row, "sequence_number").toString(),
      sessionId,
      source: eventSourceFromRow(row),
    }),
  );
}

function eventSourceFromRow(
  row: SessionSqlRow,
): SessionEventEnvelope["source"] {
  const kind = rowString(row, "source_kind");
  const sourceSeq = rowString(row, "source_seq");
  if (kind === "runtime") {
    return { kind, sourceSeq };
  }
  if (kind === "attempt") {
    return {
      attemptId: rowString(row, "source_id"),
      kind,
      sourceSeq,
    };
  }
  throw new SessionRuntimeError(
    "session_storage_unavailable",
    "The event source identity is invalid",
  );
}

function turnFromRow(row: SessionSqlRow): Turn {
  let command: SessionPromptCommand;
  try {
    command = decodeSessionPromptCommand(rowString(row, "command_json"));
  } catch (cause) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored Turn request is invalid",
      { cause },
    );
  }
  const state = rowString(row, "state");
  const updatedAt = new Date(rowNumber(row, "updated_at")).toISOString();
  let turnState: Turn["state"];
  if (state === "queued") {
    turnState = { kind: "queued" };
  } else if (state === "running") {
    const startedAt = Reflect.get(row, "started_at");
    if (typeof startedAt !== "number") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The running Turn is incomplete",
      );
    }
    turnState = {
      kind: "running",
      startedAt: new Date(startedAt).toISOString(),
    };
  } else if (state === "succeeded") {
    const stopReason = rowNullableString(row, "stop_reason") ?? "unknown";
    const completedAt = Reflect.get(row, "completed_at");
    if (typeof completedAt !== "number") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The completed Turn is incomplete",
      );
    }
    turnState = {
      completedAt: new Date(completedAt).toISOString(),
      kind: "succeeded",
      result: { kind: "agent_result", stopReason },
    };
  } else if (state === "cancelled") {
    turnState = {
      cancelledAt: new Date(rowNumber(row, "completed_at")).toISOString(),
      kind: "cancelled",
    };
  } else if (state === "failed") {
    turnState = {
      error: {
        code: rowNullableString(row, "error_code") ?? "execution_failed",
        message:
          rowNullableString(row, "error_message") ?? "The execution failed",
        retryable: false,
      },
      failedAt: new Date(
        typeof Reflect.get(row, "completed_at") === "number"
          ? rowNumber(row, "completed_at")
          : rowNumber(row, "updated_at"),
      ).toISOString(),
      kind: "failed",
    };
  } else if (state === "indeterminate") {
    turnState = {
      kind: "indeterminate",
      reconciliation: {
        detectedAt: updatedAt,
        reason: "connection_lost",
      },
    };
  } else {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored Turn state is invalid",
    );
  }
  return {
    acceptedAt: new Date(rowNumber(row, "created_at")).toISOString(),
    bindingId: rowString(row, "binding_id"),
    idempotencyKey: rowString(row, "idempotency_key"),
    request: { content: command.prompt, kind: "prompt" },
    sessionId: command.sessionId,
    state: turnState,
    turnId: rowString(row, "turn_id"),
  };
}

function attemptFromResourceRow(row: SessionSqlRow): Attempt {
  const state = rowString(row, "state");
  const startedAt = new Date(rowNumber(row, "started_at")).toISOString();
  const updatedAt = new Date(rowNumber(row, "updated_at")).toISOString();
  let attemptState: Attempt["state"];
  if (state === "dispatching") {
    attemptState = { dispatchedAt: startedAt, kind: "dispatching" };
  } else if (state === "running") {
    attemptState = { kind: "running", startedAt };
  } else if (state === "waiting_input") {
    const interactionIds = identifierArrayFromJson(
      rowString(row, "waiting_interaction_ids_json"),
      "waiting Interaction",
    );
    if (interactionIds.length === 0) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The waiting Attempt has no pending Interaction",
      );
    }
    attemptState = { interactionIds, kind: "waiting_input", startedAt };
  } else if (state === "succeeded") {
    const completedAt = Reflect.get(row, "completed_at");
    if (typeof completedAt !== "number") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The completed Attempt is incomplete",
      );
    }
    const stopReason = rowNullableString(row, "stop_reason") ?? "unknown";
    attemptState = {
      completedAt: new Date(completedAt).toISOString(),
      kind: "succeeded",
      result: { kind: "agent_result", stopReason },
      startedAt,
    };
  } else if (state === "cancelled") {
    attemptState = {
      cancelledAt: new Date(rowNumber(row, "completed_at")).toISOString(),
      kind: "cancelled",
      startedAt,
    };
  } else if (state === "failed") {
    attemptState = {
      error: {
        code: rowNullableString(row, "error_code") ?? "execution_failed",
        message:
          rowNullableString(row, "error_message") ?? "The execution failed",
        retryable: false,
      },
      failedAt: new Date(
        typeof Reflect.get(row, "completed_at") === "number"
          ? rowNumber(row, "completed_at")
          : rowNumber(row, "updated_at"),
      ).toISOString(),
      kind: "failed",
      startedAt,
    };
  } else if (state === "indeterminate") {
    attemptState = {
      kind: "indeterminate",
      reconciliation: { detectedAt: updatedAt, reason: "connection_lost" },
      startedAt,
    };
  } else {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored Attempt state is invalid",
    );
  }
  return {
    attemptId: rowString(row, "attempt_id"),
    bindingId: rowString(row, "binding_id"),
    sessionId: rowString(row, "session_id"),
    state: attemptState,
    turnId: rowString(row, "turn_id"),
  };
}

function interactionFromRow(row: SessionSqlRow): Interaction {
  let request: Interaction["request"];
  try {
    request = decodeInteractionRequest(
      JSON.parse(rowString(row, "request_json")),
    );
  } catch (cause) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored Interaction request is invalid",
      { cause },
    );
  }
  const state = rowString(row, "state");
  let interactionState: Interaction["state"];
  if (state === "pending") {
    interactionState = { kind: "pending" };
  } else if (state === "responded") {
    const responseJson = rowNullableString(row, "response_json");
    const responderId = rowNullableString(row, "responder_id");
    const respondedAt = Reflect.get(row, "responded_at");
    if (
      responseJson === null ||
      responderId === null ||
      typeof respondedAt !== "number"
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The responded Interaction is incomplete",
      );
    }
    let responseValue: unknown;
    try {
      responseValue = JSON.parse(responseJson);
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The Interaction response is invalid",
        { cause },
      );
    }
    if (
      !isRecord(responseValue) ||
      (responseValue["kind"] !== "permission" &&
        responseValue["kind"] !== "elicitation") ||
      typeof responseValue["content"] !== "string"
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The Interaction response is invalid",
      );
    }
    interactionState = {
      kind: "responded",
      respondedAt: new Date(respondedAt).toISOString(),
      responderId,
      response: {
        content: responseValue["content"],
        kind: responseValue["kind"],
      },
    };
  } else if (state === "resolved") {
    const responseJson = rowNullableString(row, "response_json");
    const responderId = rowNullableString(row, "responder_id");
    const respondedAt = Reflect.get(row, "responded_at");
    let resolution: Extract<
      Interaction["state"],
      { readonly kind: "resolved" }
    >["resolution"];
    if (
      responseJson === null &&
      responderId === null &&
      (respondedAt === null || respondedAt === undefined)
    ) {
      resolution = { kind: "without_response" };
    } else if (
      responseJson !== null &&
      responderId !== null &&
      typeof respondedAt === "number"
    ) {
      let responseValue: unknown;
      try {
        responseValue = JSON.parse(responseJson);
      } catch (cause) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The resolved Interaction response is invalid",
          { cause },
        );
      }
      resolution = {
        kind: "response_applied",
        respondedAt: new Date(respondedAt).toISOString(),
        responderId,
        response: decodeInteractionResponse(responseValue),
      };
    } else {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The resolved Interaction response is incomplete",
      );
    }
    interactionState = {
      kind: "resolved",
      resolution,
      resolvedAt: new Date(rowNumber(row, "resolved_at")).toISOString(),
    };
  } else if (state === "expired") {
    interactionState = {
      expiredAt: new Date(rowNumber(row, "resolved_at")).toISOString(),
      kind: "expired",
    };
  } else if (state === "cancelled") {
    interactionState = {
      cancelledAt: new Date(rowNumber(row, "resolved_at")).toISOString(),
      kind: "cancelled",
    };
  } else {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored Interaction state is invalid",
    );
  }
  return {
    attemptId: rowString(row, "attempt_id"),
    interactionId: rowString(row, "interaction_id"),
    request,
    sessionId: rowString(row, "session_id"),
    state: interactionState,
    turnId: rowString(row, "turn_id"),
  };
}

function identifierArrayFromJson(encoded: string, field: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      `The stored ${field} list is invalid`,
      { cause },
    );
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || !IDENTIFIER_PATTERN.test(entry),
    )
  ) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      `The stored ${field} list is invalid`,
    );
  }
  return value;
}

function pendingWorkFromRow(
  row: SessionSqlRow,
  scope: ProjectScope,
): PendingWork {
  const kind = rowString(row, "work_kind");
  if (
    kind !== "archive" &&
    kind !== "delete" &&
    kind !== "dispatch" &&
    kind !== "interaction_response" &&
    kind !== "projection"
  ) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored PendingWork kind is invalid",
    );
  }
  const state = rowString(row, "state");
  let workState: PendingWork["state"];
  if (state === "pending") {
    workState = {
      kind: "pending",
      queuedAt: new Date(rowNumber(row, "queued_at")).toISOString(),
    };
  } else if (state === "running") {
    workState = {
      attempt: rowNumber(row, "attempt_count"),
      kind: "running",
      startedAt: new Date(rowNumber(row, "started_at")).toISOString(),
    };
  } else if (state === "completed") {
    workState = {
      completedAt: new Date(rowNumber(row, "completed_at")).toISOString(),
      kind: "completed",
    };
  } else if (state === "retryable" || state === "failed") {
    const error = {
      code: rowNullableString(row, "error_code") ?? "delivery_failed",
      message: rowNullableString(row, "error_message") ?? "Pending work failed",
      retryable: state === "retryable",
    };
    workState =
      state === "retryable"
        ? {
            error,
            kind: "retryable",
            nextAttemptAt: new Date(
              rowNumber(row, "next_attempt_at"),
            ).toISOString(),
          }
        : {
            error,
            failedAt: new Date(rowNumber(row, "completed_at")).toISOString(),
            kind: "failed",
          };
  } else {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The stored PendingWork state is invalid",
    );
  }
  return {
    kind,
    projectId: scope.projectId,
    sessionId: rowString(row, "session_id"),
    state: workState,
    tenantId: scope.tenantId,
    workId: rowString(row, "work_id"),
  };
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

function parseSegments(encoded: string): readonly StoredArchiveChunk[] {
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
      CREATE TABLE IF NOT EXISTS sessions (
        scope_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        directory_id TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        binding_created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        native_history_json TEXT,
        recording_level TEXT NOT NULL CHECK (recording_level IN ('full', 'summary')),
        retention_milliseconds INTEGER NOT NULL,
        idempotency_retention_milliseconds INTEGER NOT NULL,
        hot_event_limit INTEGER NOT NULL,
        content_limit_bytes INTEGER NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready', 'deleting', 'deleted')),
        delete_requested_at INTEGER NOT NULL DEFAULT 0,
        delete_completed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        minimum_sequence INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope_key, session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_directory
        ON sessions(scope_key, updated_at DESC, session_id DESC);
      CREATE TABLE IF NOT EXISTS session_bindings (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent_ref TEXT NOT NULL,
        workspace_ref TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, binding_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turns (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate')),
        response TEXT NOT NULL DEFAULT '',
        attempt_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_id),
        UNIQUE (scope_key, session_id, turn_id),
        UNIQUE (scope_key, session_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS turns_page
        ON turns(scope_key, session_id, created_at DESC, command_id DESC);
      CREATE TABLE IF NOT EXISTS command_receipts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_kind, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'indeterminate')),
        started_at INTEGER NOT NULL,
        waiting_interaction_ids_json TEXT NOT NULL DEFAULT '[]',
        completed_at INTEGER,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, attempt_id),
        UNIQUE (scope_key, session_id, turn_id, attempt_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS interactions (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'responded', 'resolved', 'expired', 'cancelled')),
        response_json TEXT,
        responder_id TEXT,
        responded_at INTEGER,
        resolved_at INTEGER,
        PRIMARY KEY (scope_key, session_id, interaction_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pending_work (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        work_kind TEXT NOT NULL CHECK (work_kind IN ('archive', 'delete', 'dispatch', 'interaction_response', 'projection')),
        runtime_id TEXT NOT NULL,
        interaction_id TEXT,
        delivery_payload TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'retryable', 'failed')),
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        next_attempt_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        PRIMARY KEY (scope_key, session_id, work_id),
        UNIQUE (scope_key, session_id, interaction_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_work_delivery
        ON pending_work(scope_key, runtime_id, state, queued_at, work_id);
      CREATE TABLE IF NOT EXISTS session_events (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('attempt', 'runtime')),
        source_id TEXT NOT NULL,
        source_seq TEXT NOT NULL,
        payload TEXT,
        archive_segment_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, sequence_number),
        UNIQUE (scope_key, session_id, event_id),
        UNIQUE (scope_key, session_id, source_kind, source_id, source_seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tool_call_views (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        detail_kind TEXT NOT NULL CHECK (detail_kind IN ('available', 'truncated', 'unrecorded')),
        detail_artifact_id TEXT,
        hot_detail TEXT,
        captured_bytes INTEGER NOT NULL DEFAULT 0,
        original_bytes INTEGER NOT NULL DEFAULT 0,
        event_sequence INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, attempt_id, activity_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'deleting', 'deleted', 'failed', 'expired')),
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunks_json TEXT,
        PRIMARY KEY (scope_key, session_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS archive_segments (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'published', 'deleting', 'deleted')),
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunks_json TEXT,
        PRIMARY KEY (scope_key, session_id, segment_id),
        CHECK (first_sequence <= last_sequence),
        CHECK (event_count = last_sequence - first_sequence + 1)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS archive_segments_range
        ON archive_segments(scope_key, session_id, first_sequence, last_sequence);
      CREATE TABLE IF NOT EXISTS archive_work (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        archive_kind TEXT NOT NULL CHECK (archive_kind IN ('activity', 'event')),
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        hot_payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope_key, session_id, target_id)
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
        summary.createdBy === request.createdBy &&
        rowString(existing, "binding_id") === request.bindingId &&
        rowString(existing, "directory_id") === request.directoryId &&
        rowNumber(existing, "config_revision") ===
          request.binding.configRevision &&
        summary.policy.level === request.policy.level &&
        summary.policy.retentionMilliseconds ===
          request.policy.retentionMilliseconds &&
        summary.policy.idempotencyRetentionMilliseconds ===
          request.policy.idempotencyRetentionMilliseconds &&
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
    this.#database.transaction(() => {
      this.assertSessionQuota(scope);
      this.#database.run(
        `INSERT INTO sessions (
         scope_key, tenant_id, project_id, session_id, created_by, runtime_id,
         agent_id, binding_id, directory_id, config_revision,
         binding_created_at, title, native_history_json, recording_level, retention_milliseconds,
         idempotency_retention_milliseconds, hot_event_limit,
         content_limit_bytes, lifecycle, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        [
          key,
          scope.tenantId,
          scope.projectId,
          request.sessionId,
          request.createdBy,
          request.runtimeId,
          request.agentId,
          request.bindingId,
          request.directoryId,
          request.binding.configRevision,
          now,
          request.title,
          request.policy.level,
          request.policy.retentionMilliseconds,
          request.policy.idempotencyRetentionMilliseconds,
          request.policy.hotEventLimit,
          request.policy.contentLimitBytes,
          now,
          now,
        ],
      );
      this.#database.run(
        `INSERT INTO session_bindings (
         scope_key, session_id, binding_id, runtime_id, agent_ref,
         workspace_ref, config_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          request.sessionId,
          request.bindingId,
          request.runtimeId,
          request.agentId,
          request.directoryId,
          request.binding.configRevision,
          now,
        ],
      );
    });
    signal.throwIfAborted();
    return summaryFromRow(
      this.requireSessionRow(scope, request.sessionId, true),
    );
  };

  readonly acceptTurn = async (
    scope: ProjectScope,
    runtimeId: string,
    command: SessionPromptCommand,
    now: number,
    signal: AbortSignal,
  ): Promise<TurnAcceptance> => {
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
            idempotencyRetentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
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
    const requestHash = await sha256(new TextEncoder().encode(encodedCommand));
    const binding = this.#database.query(
      `SELECT binding_id FROM session_bindings
       WHERE scope_key = ? AND session_id = ? AND binding_id = ?
         AND runtime_id = ? AND agent_ref = ? AND workspace_ref = ?`,
      [
        key,
        validatedCommand.sessionId,
        validatedCommand.bindingId,
        runtimeId,
        validatedCommand.agentId,
        validatedCommand.directoryId,
      ],
    )[0];
    if (binding === undefined) {
      throw new SessionRuntimeError(
        "session_access_denied",
        "The Turn binding is not registered for this Session and Runtime",
      );
    }
    return this.#database.transaction(() => {
      const duplicate = this.#database.query(
        `SELECT t.* FROM command_receipts r
         JOIN turns t
           ON t.scope_key = r.scope_key AND t.session_id = r.session_id
          AND t.turn_id = r.result_id
         WHERE r.scope_key = ? AND r.session_id = ?
           AND r.command_kind = ? AND r.idempotency_key = ?`,
        [
          key,
          validatedCommand.sessionId,
          validatedCommand.kind,
          validatedCommand.commandId,
        ],
      )[0];
      if (duplicate !== undefined) {
        if (rowString(duplicate, "request_hash") !== requestHash) {
          throw new SessionRuntimeError(
            "idempotency_conflict",
            "The idempotency key was reused with different Turn input",
          );
        }
        const state = rowString(duplicate, "state");
        if (
          state !== "queued" &&
          state !== "running" &&
          state !== "succeeded" &&
          state !== "failed" &&
          state !== "cancelled" &&
          state !== "indeterminate"
        ) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The command state is invalid",
          );
        }
        const turn = turnFromRow(duplicate);
        const pending = this.#database.query(
          `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
          [key, validatedCommand.sessionId, `dispatch_${turn.turnId}`],
        )[0];
        return {
          kind: "duplicate",
          pendingWork:
            pending === undefined ? null : pendingWorkFromRow(pending, scope),
          state,
          turn,
        };
      }
      const active = this.#database.query(
        `SELECT command_id FROM turns
         WHERE scope_key = ? AND session_id = ?
           AND state IN ('queued', 'running', 'indeterminate')
         LIMIT 1`,
        [key, validatedCommand.sessionId],
      )[0];
      if (active !== undefined) {
        throw new SessionRuntimeError(
          "session_busy",
          "The session already has an active command",
        );
      }
      const turnId = `turn_${crypto.randomUUID()}`;
      const workId = `dispatch_${turnId}`;
      this.#database.run(
        `INSERT INTO turns (
           scope_key, session_id, command_id, turn_id, binding_id,
           idempotency_key, request_hash, command_json, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          key,
          validatedCommand.sessionId,
          validatedCommand.commandId,
          turnId,
          validatedCommand.bindingId,
          validatedCommand.commandId,
          requestHash,
          encodedCommand,
          now,
          now,
        ],
      );
      this.#database.run(
        `INSERT INTO command_receipts (
           scope_key, session_id, command_kind, idempotency_key,
           request_hash, result_id, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          validatedCommand.sessionId,
          validatedCommand.kind,
          validatedCommand.commandId,
          requestHash,
          turnId,
          now,
        ],
      );
      this.#database.run(
        `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
        [
          key,
          validatedCommand.sessionId,
          workId,
          runtimeId,
          encodedCommand,
          now,
        ],
      );
      this.#database.run(
        `UPDATE sessions SET updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [now, key, validatedCommand.sessionId],
      );
      const accepted = this.#database.query(
        `SELECT * FROM turns
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
        [key, validatedCommand.sessionId, turnId],
      )[0];
      if (accepted === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The accepted Turn could not be read",
        );
      }
      const pending = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, validatedCommand.sessionId, workId],
      )[0];
      if (pending === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The Turn dispatch was not committed atomically",
        );
      }
      return {
        kind: "accepted",
        pendingWork: pendingWorkFromRow(pending, scope),
        turn: turnFromRow(accepted),
      };
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
    const key = scopeKey(scope);
    const sourceKind = validatedEnvelope.source.kind;
    if ("commandId" in decoded && sourceKind !== "attempt") {
      throw new SessionRuntimeError(
        "event_source_conflict",
        "An execution event requires an Attempt source identity",
      );
    }
    let owningRuntimeId: string;
    if (sourceKind === "attempt") {
      const ownership =
        decoded.kind === SESSION_STARTED_KIND ||
        decoded.kind === SESSION_FAILED_KIND
          ? this.#database.query(
              `SELECT b.runtime_id
               FROM turns c
               JOIN session_bindings b
                 ON b.scope_key = c.scope_key AND b.session_id = c.session_id
                AND b.binding_id = c.binding_id
               WHERE c.scope_key = ? AND c.session_id = ? AND c.command_id = ?`,
              [key, validatedEnvelope.sessionId, decoded.commandId],
            )[0]
          : this.#database.query(
              `SELECT b.runtime_id
               FROM attempts a
               JOIN session_bindings b
                 ON b.scope_key = a.scope_key AND b.session_id = a.session_id
                AND b.binding_id = a.binding_id
               WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?`,
              [
                key,
                validatedEnvelope.sessionId,
                validatedEnvelope.source.attemptId,
              ],
            )[0];
      if (ownership === undefined) {
        throw new SessionRuntimeError(
          "event_source_conflict",
          "The event references an unknown Attempt source",
        );
      }
      owningRuntimeId = rowString(ownership, "runtime_id");
    } else if ("commandId" in decoded) {
      const ownership = this.#database.query(
        `SELECT b.runtime_id
         FROM turns c
         JOIN session_bindings b
           ON b.scope_key = c.scope_key AND b.session_id = c.session_id
          AND b.binding_id = c.binding_id
         WHERE c.scope_key = ? AND c.session_id = ? AND c.command_id = ?`,
        [key, validatedEnvelope.sessionId, decoded.commandId],
      )[0];
      owningRuntimeId =
        ownership === undefined
          ? rowString(session, "runtime_id")
          : rowString(ownership, "runtime_id");
    } else {
      owningRuntimeId = rowString(session, "runtime_id");
    }
    if (owningRuntimeId !== runtimeId) {
      throw new SessionRuntimeError(
        "session_access_denied",
        "The Runtime does not own the event's immutable binding",
      );
    }
    const sourceId =
      sourceKind === "attempt" ? validatedEnvelope.source.attemptId : runtimeId;
    const sourceSeq = validatedEnvelope.source.sourceSeq;
    const payloadHash = await sha256(
      new TextEncoder().encode(validatedEnvelope.payload),
    );
    if (sourceKind === "attempt") {
      if (
        decoded.kind === SESSION_STARTED_KIND &&
        decoded.attemptId !== sourceId
      ) {
        throw new SessionRuntimeError(
          "event_source_conflict",
          "The event source does not match the Attempt identity",
        );
      }
      if (decoded.kind !== SESSION_STARTED_KIND && "commandId" in decoded) {
        const command = this.#database.query(
          `SELECT attempt_id, state FROM turns
           WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
          [key, validatedEnvelope.sessionId, decoded.commandId],
        )[0];
        const existingAttemptId =
          command === undefined
            ? null
            : rowNullableString(command, "attempt_id");
        if (
          command === undefined ||
          (existingAttemptId === null
            ? decoded.kind !== SESSION_FAILED_KIND ||
              rowString(command, "state") !== "queued"
            : existingAttemptId !== sourceId)
        ) {
          throw new SessionRuntimeError(
            "event_source_conflict",
            "The event source does not own the referenced Turn",
          );
        }
      }
    }
    const duplicate = this.#database.query(
      `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, archive_segment_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
         AND (event_id = ? OR
              (source_kind = ? AND source_id = ? AND source_seq = ?))`,
      [
        key,
        validatedEnvelope.sessionId,
        validatedEnvelope.eventId,
        sourceKind,
        sourceId,
        sourceSeq,
      ],
    )[0];
    if (duplicate !== undefined) {
      if (
        rowString(duplicate, "event_id") !== validatedEnvelope.eventId ||
        rowString(duplicate, "payload_hash") !== payloadHash ||
        rowString(duplicate, "source_kind") !== sourceKind ||
        rowString(duplicate, "source_id") !== sourceId ||
        rowString(duplicate, "source_seq") !== sourceSeq
      ) {
        throw new SessionRuntimeError(
          "event_source_conflict",
          "A persisted event identity was reused with different content",
        );
      }
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
      const previousSource = this.#database.query(
        `SELECT source_seq
         FROM session_events
         WHERE scope_key = ? AND session_id = ? AND source_kind = ?
           AND source_id = ?
         ORDER BY length(source_seq) DESC, source_seq DESC
         LIMIT 1`,
        [key, validatedEnvelope.sessionId, sourceKind, sourceId],
      )[0];
      const expectedSourceSeq =
        previousSource === undefined
          ? "1"
          : (BigInt(rowString(previousSource, "source_seq")) + 1n).toString();
      if (sourceSeq !== expectedSourceSeq) {
        throw new SessionRuntimeError(
          "event_source_conflict",
          "The event source sequence is not contiguous",
        );
      }
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
        sourceKind === "attempt" ? sourceId : null,
        now,
      );
      const archiveSegmentId = `segment-${validatedEnvelope.eventId}`;
      this.queueEventArchive(
        key,
        validatedEnvelope.sessionId,
        archiveSegmentId,
        validatedEnvelope.eventId,
        sequence,
        "application/json",
        prepared.payload,
      );
      if (prepared.activityDetail !== null) {
        this.queueArtifactArchive(
          key,
          validatedEnvelope.sessionId,
          prepared.activityDetail.artifactId,
          prepared.activityDetail.activityId,
          "application/json",
          prepared.activityDetail.payload,
        );
      }
      this.#database.run(
        `INSERT INTO session_events (
           scope_key, session_id, sequence_number, event_id, payload_hash,
           source_kind, source_id, source_seq, payload, archive_segment_id,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          validatedEnvelope.sessionId,
          sequence,
          validatedEnvelope.eventId,
          payloadHash,
          sourceKind,
          sourceId,
          sourceSeq,
          prepared.payload,
          archiveSegmentId,
          now,
        ],
      );
      this.#database.run(
        `UPDATE sessions
         SET next_sequence = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [sequence + 1, now, key, validatedEnvelope.sessionId],
      );
      return {
        cursor: eventCursor(scope, validatedEnvelope.sessionId, sequence),
        eventId: validatedEnvelope.eventId,
        kind: SESSION_EVENT_COMMITTED_KIND,
        payload: prepared.payload,
        recordedAt: new Date(now).toISOString(),
        sequence: sequence.toString(),
        sessionId: validatedEnvelope.sessionId,
        source: validatedEnvelope.source,
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

  readonly setDefaultBinding = async (
    scope: ProjectScope,
    sessionId: string,
    binding: CreateSessionBindingRequest,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(binding.bindingId, "binding");
    validateDomainIdentifier(binding.runtimeId, "runtime");
    validateDomainIdentifier(binding.agentRef, "agent");
    validateDomainIdentifier(binding.workspaceRef, "workspace");
    if (
      !Number.isSafeInteger(binding.configRevision) ||
      binding.configRevision < 0
    ) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The binding configuration revision is invalid",
      );
    }
    this.requireActiveSessionRow(scope, sessionId, now);
    const key = scopeKey(scope);
    this.#database.transaction(() => {
      const existing = this.#database.query(
        `SELECT * FROM session_bindings
         WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
        [key, sessionId, binding.bindingId],
      )[0];
      let bindingCreatedAt = now;
      if (existing === undefined) {
        this.#database.run(
          `INSERT INTO session_bindings (
             scope_key, session_id, binding_id, runtime_id, agent_ref,
             workspace_ref, config_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            sessionId,
            binding.bindingId,
            binding.runtimeId,
            binding.agentRef,
            binding.workspaceRef,
            binding.configRevision,
            now,
          ],
        );
      } else {
        const changed =
          rowString(existing, "runtime_id") !== binding.runtimeId ||
          rowString(existing, "agent_ref") !== binding.agentRef ||
          rowString(existing, "workspace_ref") !== binding.workspaceRef ||
          rowNumber(existing, "config_revision") !== binding.configRevision;
        if (changed) {
          const used = this.#database.query(
            `SELECT 1 FROM turns
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?
             LIMIT 1`,
            [key, sessionId, binding.bindingId],
          )[0];
          if (used !== undefined) {
            throw new SessionRuntimeError(
              "session_conflict",
              "A used Session binding is immutable",
            );
          }
          this.#database.run(
            `UPDATE session_bindings
             SET runtime_id = ?, agent_ref = ?, workspace_ref = ?,
                 config_revision = ?, created_at = ?
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
            [
              binding.runtimeId,
              binding.agentRef,
              binding.workspaceRef,
              binding.configRevision,
              now,
              key,
              sessionId,
              binding.bindingId,
            ],
          );
        } else {
          bindingCreatedAt = rowNumber(existing, "created_at");
        }
      }
      this.#database.run(
        `UPDATE sessions
         SET binding_id = ?, runtime_id = ?, agent_id = ?, directory_id = ?,
             config_revision = ?, binding_created_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
        [
          binding.bindingId,
          binding.runtimeId,
          binding.agentRef,
          binding.workspaceRef,
          binding.configRevision,
          bindingCreatedAt,
          now,
          key,
          sessionId,
        ],
      );
    });
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

  readonly readNativeHistory = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<NativeSessionHistory | null> => {
    signal.throwIfAborted();
    const row = this.requireActiveSessionRow(scope, sessionId, Date.now());
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

  readonly recordNativeHistory = async (
    scope: ProjectScope,
    runtimeId: string,
    sessionId: string,
    title: string,
    history: NativeSessionHistory,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(runtimeId, "runtime");
    if (title.length > 500) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The native Session title is invalid",
      );
    }
    const session = this.requireActiveSessionRow(scope, sessionId, now);
    if (rowString(session, "runtime_id") !== runtimeId) {
      throw new SessionRuntimeError(
        "session_access_denied",
        "The Runtime does not own the native Session history",
      );
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(decodeNativeSessionHistory(history));
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The native Session history is invalid",
        { cause },
      );
    }
    if (
      new TextEncoder().encode(encoded).byteLength >
      rowNumber(session, "content_limit_bytes")
    ) {
      throw new SessionRuntimeError(
        "content_too_large",
        "The native Session history exceeds the recording limit",
      );
    }
    this.#database.run(
      `UPDATE sessions
       SET native_history_json = ?, title = ?, updated_at = ?
       WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
      [encoded, title, now, scopeKey(scope), sessionId],
    );
    signal.throwIfAborted();
    return summaryFromRow(this.requireSessionRow(scope, sessionId, true));
  };

  readonly readTurn = async (
    scope: ProjectScope,
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Turn> => {
    signal.throwIfAborted();
    this.requireActiveSessionRow(scope, sessionId, Date.now());
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
    this.requireActiveSessionRow(scope, sessionId, Date.now());
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
    this.requireActiveSessionRow(scope, sessionId, Date.now());
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
    this.requireActiveSessionRow(scope, sessionId, Date.now());
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

  readonly acceptInteractionResponse = async (
    scope: ProjectScope,
    sessionId: string,
    interactionId: string,
    responderId: string,
    response: InteractionResponse,
    deliveryPayload: string,
    now: number,
    signal: AbortSignal,
  ): Promise<InteractionResponseAcceptance> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(interactionId, "interaction");
    validateDomainIdentifier(responderId, "responder");
    if (
      deliveryPayload.length === 0 ||
      new TextEncoder().encode(deliveryPayload).byteLength > 8 * 1024 * 1024
    ) {
      throw new SessionRuntimeError(
        "interaction_conflict",
        "The Interaction response delivery payload is invalid",
      );
    }
    let validatedResponse: InteractionResponse;
    try {
      validatedResponse = decodeInteractionResponse(response);
    } catch (cause) {
      throw new SessionRuntimeError(
        "interaction_conflict",
        "The Interaction response is invalid",
        { cause },
      );
    }
    const key = scopeKey(scope);
    this.requireActiveSessionRow(scope, sessionId, now);
    const encodedResponse = JSON.stringify(validatedResponse);
    const workDigest = await sha256(
      new TextEncoder().encode(
        `${key}\u0000${sessionId}\u0000${interactionId}`,
      ),
    );
    const workId = `work_${workDigest.slice(0, 32)}`;
    signal.throwIfAborted();
    return this.#database.transaction(() => {
      const interaction = this.#database.query(
        `SELECT i.*, b.runtime_id
         FROM interactions i
         JOIN attempts a
           ON a.scope_key = i.scope_key AND a.session_id = i.session_id
          AND a.attempt_id = i.attempt_id
         JOIN session_bindings b
           ON b.scope_key = a.scope_key AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE i.scope_key = ? AND i.session_id = ? AND i.interaction_id = ?`,
        [key, sessionId, interactionId],
      )[0];
      if (interaction === undefined) {
        throw new SessionRuntimeError(
          "interaction_not_found",
          "The Interaction does not exist",
        );
      }
      if (
        interactionFromRow(interaction).request.kind !== validatedResponse.kind
      ) {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "The response kind does not match the Interaction request",
        );
      }
      const state = rowString(interaction, "state");
      if (state === "responded") {
        const work = this.#database.query(
          `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
          [key, sessionId, interactionId],
        )[0];
        if (
          rowNullableString(interaction, "response_json") !== encodedResponse ||
          rowNullableString(interaction, "responder_id") !== responderId ||
          work === undefined ||
          rowNullableString(work, "delivery_payload") !== deliveryPayload
        ) {
          throw new SessionRuntimeError(
            "interaction_conflict",
            "The Interaction response identity was reused with different input",
          );
        }
        return {
          duplicate: true,
          interaction: interactionFromRow(interaction),
          pendingWork: pendingWorkFromRow(work, scope),
        };
      }
      if (state !== "pending") {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "The Interaction no longer accepts a response",
        );
      }
      this.#database.run(
        `UPDATE interactions
         SET state = 'responded', response_json = ?, responder_id = ?,
             responded_at = ?
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [encodedResponse, responderId, now, key, sessionId, interactionId],
      );
      this.#database.run(
        `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           interaction_id, delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'interaction_response', ?, ?, ?, 'pending', ?)`,
        [
          key,
          sessionId,
          workId,
          rowString(interaction, "runtime_id"),
          interactionId,
          deliveryPayload,
          now,
        ],
      );
      const updatedInteraction = this.#database.query(
        `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [key, sessionId, interactionId],
      )[0];
      const pendingWork = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (updatedInteraction === undefined || pendingWork === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The Interaction response was not persisted atomically",
        );
      }
      return {
        duplicate: false,
        interaction: interactionFromRow(updatedInteraction),
        pendingWork: pendingWorkFromRow(pendingWork, scope),
      };
    });
  };

  readonly listPendingDaemonDeliveries = async (
    scope: ProjectScope,
    runtimeId: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly PendingDaemonDelivery[]> => {
    signal.throwIfAborted();
    scopeKey(scope);
    validateDomainIdentifier(runtimeId, "runtime");
    validateLimit(limit);
    return this.#database
      .query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND runtime_id = ?
           AND work_kind IN ('dispatch', 'interaction_response')
           AND state IN ('pending', 'retryable')
         ORDER BY queued_at, work_id
         LIMIT ?`,
        [scopeKey(scope), runtimeId, limit],
      )
      .map((row) => {
        const workKind = rowString(row, "work_kind");
        const interactionId = rowNullableString(row, "interaction_id");
        const payload = rowNullableString(row, "delivery_payload");
        if (
          payload === null ||
          (workKind === "interaction_response" && interactionId === null)
        ) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The pending daemon delivery is incomplete",
          );
        }
        return {
          interactionId,
          payload,
          pendingWork: pendingWorkFromRow(row, scope),
        };
      });
  };

  readonly markPendingWorkCompleted = async (
    scope: ProjectScope,
    sessionId: string,
    workId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<PendingWork> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(workId, "pending work");
    this.requireActiveSessionRow(scope, sessionId, now);
    const key = scopeKey(scope);
    return this.#database.transaction(() => {
      const work = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (work === undefined) {
        throw new SessionRuntimeError(
          "pending_work_not_found",
          "The PendingWork item does not exist",
        );
      }
      const state = rowString(work, "state");
      if (state !== "completed") {
        if (state === "failed") {
          throw new SessionRuntimeError(
            "session_conflict",
            "The failed PendingWork item cannot complete",
          );
        }
        this.#database.run(
          `UPDATE pending_work
           SET state = 'completed', completed_at = ?, error_code = NULL,
               error_message = NULL
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
          [now, key, sessionId, workId],
        );
      }
      const updated = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (updated === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The completed PendingWork item disappeared",
        );
      }
      return pendingWorkFromRow(updated, scope);
    });
  };

  readonly reconcileAttempt = async (
    scope: ProjectScope,
    runtimeId: string,
    sessionId: string,
    attemptId: string,
    outcome: import("./session-runtime.ts").AttemptReconciliationOutcome,
    now: number,
    signal: AbortSignal,
  ): Promise<Attempt> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(runtimeId, "runtime");
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(attemptId, "attempt");
    this.requireActiveSessionRow(scope, sessionId, now);
    const key = scopeKey(scope);
    this.#database.transaction(() => {
      const attempt = this.#database.query(
        `SELECT a.* FROM attempts a
         JOIN session_bindings b
           ON b.scope_key = a.scope_key
          AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?
           AND b.runtime_id = ?`,
        [key, sessionId, attemptId, runtimeId],
      )[0];
      if (
        attempt === undefined ||
        rowString(attempt, "state") !== "indeterminate"
      ) {
        throw new SessionRuntimeError(
          "session_conflict",
          "Only the owning Runtime can reconcile an indeterminate Attempt",
        );
      }
      const turnId = rowString(attempt, "turn_id");
      if (outcome.kind === "running") {
        this.#database.run(
          `UPDATE attempts SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, key, sessionId, turnId],
        );
        return;
      }
      if (outcome.kind === "succeeded") {
        this.#database.run(
          `UPDATE attempts
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, outcome.stopReason, now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, outcome.stopReason, now, key, sessionId, turnId],
        );
        return;
      }
      if (outcome.kind === "cancelled") {
        this.#database.run(
          `UPDATE attempts
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, now, key, sessionId, turnId],
        );
        return;
      }
      this.#database.run(
        `UPDATE attempts
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
        [
          now,
          outcome.error.code,
          outcome.error.message,
          now,
          key,
          sessionId,
          attemptId,
        ],
      );
      this.#database.run(
        `UPDATE turns
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
        [
          now,
          outcome.error.code,
          outcome.error.message,
          now,
          key,
          sessionId,
          turnId,
        ],
      );
    });
    signal.throwIfAborted();
    return await this.readAttempt(scope, sessionId, attemptId, signal);
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
    const key = scopeKey(scope);
    this.#database.transaction(() => {
      this.#database.run(
        `UPDATE attempts
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ?
           AND state IN ('dispatching', 'running', 'waiting_input')
           AND (session_id, binding_id) IN (
             SELECT session_id, binding_id FROM session_bindings
             WHERE scope_key = ? AND runtime_id = ?
           )`,
        [now, key, key, runtimeId],
      );
      this.#database.run(
        `UPDATE turns
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ? AND state IN ('queued', 'running')
           AND turn_id IN (
             SELECT turn_id FROM attempts
             WHERE scope_key = ? AND state = 'indeterminate'
           )`,
        [now, key, key],
      );
    });
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
      `SELECT target_id, archive_kind, owner_id, media_type, hot_payload
       FROM archive_work
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
          `UPDATE archive_work
           SET attempts = attempts + 1, last_error = ?
           WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
          [
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Archive upload failed",
            scopeKey(scope),
            sessionId,
            rowString(job, "target_id"),
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
    if (existingLifecycle.kind === "ready") {
      this.#database.run(
        `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
        [now, now, scopeKey(scope), sessionId],
      );
    }
    await this.deleteArchivedContent(scope, sessionId, signal);
    this.#database.transaction(() => {
      for (const table of [
        "archive_work",
        "archive_segments",
        "artifacts",
        "tool_call_views",
        "pending_work",
        "interactions",
        "session_events",
        "attempts",
        "command_receipts",
        "turns",
        "session_bindings",
      ]) {
        this.#database.run(
          `DELETE FROM ${table} WHERE scope_key = ? AND session_id = ?`,
          [scopeKey(scope), sessionId],
        );
      }
      this.#database.run(
        `UPDATE sessions
         SET lifecycle = 'deleted', delete_completed_at = ?,
             native_history_json = NULL, updated_at = ?
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
      `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, archive_segment_id, recorded_at
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
      `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ?
       ORDER BY created_at DESC, command_id DESC`,
      [scopeKey(scope), sessionId],
    );
    const turns: SessionExport["turns"][number][] = commandRows.map((row) => {
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
        state: this.attemptFromRow(row) ?? { kind: "queued" },
        turn: turnFromRow(row),
        updatedAt: new Date(rowNumber(row, "updated_at")).toISOString(),
      };
    });
    const activityRows = this.#database.query(
      `SELECT attempt_id, summary_json, event_sequence
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ?
       ORDER BY event_sequence, attempt_id, activity_id`,
      [scopeKey(scope), sessionId],
    );
    const toolCallViews: SessionExport["toolCallViews"][number][] =
      activityRows.map((row) => {
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
        return {
          attemptId: rowString(row, "attempt_id"),
          event,
          eventSequence: rowNumber(row, "event_sequence").toString(),
        };
      });
    const artifactRows = this.#database.query(
      `SELECT attempt_id, activity_id, detail_artifact_id, hot_detail
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND detail_kind = 'available'
       ORDER BY attempt_id, activity_id`,
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
        attemptId: rowString(row, "attempt_id"),
        artifactId,
        byteLength: bytes.byteLength,
        contentBase64: encodeBase64(bytes),
        contentEncoding: "identity",
        mediaType: "application/json",
        sha256: await sha256(bytes),
        toolCallId: rowString(row, "activity_id"),
      });
    }
    const bindings = this.#database
      .query(
        `SELECT * FROM session_bindings
         WHERE scope_key = ? AND session_id = ?
         ORDER BY created_at, binding_id`,
        [scopeKey(scope), sessionId],
      )
      .map(bindingFromRow);
    const commandReceipts: CommandReceipt[] = this.#database
      .query(
        `SELECT * FROM command_receipts
         WHERE scope_key = ? AND session_id = ?
         ORDER BY accepted_at, idempotency_key`,
        [scopeKey(scope), sessionId],
      )
      .map((row) => {
        const acceptedAt = rowNumber(row, "accepted_at");
        return decodeCommandReceipt({
          acceptedAt: new Date(acceptedAt).toISOString(),
          commandKind: rowString(row, "command_kind"),
          expiresAt: new Date(
            acceptedAt +
              rowNumber(sessionRow, "idempotency_retention_milliseconds"),
          ).toISOString(),
          idempotencyKey: rowString(row, "idempotency_key"),
          projectId: scope.projectId,
          requestHash: rowString(row, "request_hash"),
          resultId: rowString(row, "result_id"),
          sessionId,
          tenantId: scope.tenantId,
        });
      });
    const interactions = this.#database
      .query(
        `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ?
         ORDER BY interaction_id`,
        [scopeKey(scope), sessionId],
      )
      .map(interactionFromRow);
    const nativeHistory = await this.readNativeHistory(
      scope,
      sessionId,
      signal,
    );
    if (nativeHistory !== null) {
      exportBytes += new TextEncoder().encode(
        JSON.stringify(nativeHistory),
      ).byteLength;
      if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
        throw new SessionRuntimeError(
          "content_too_large",
          "The session export exceeds the configured limit",
        );
      }
    }
    return {
      artifacts,
      bindings,
      commandReceipts,
      events,
      interactions,
      minimumSequence: rowNumber(sessionRow, "minimum_sequence").toString(),
      nativeHistory,
      nextSequence: rowNumber(sessionRow, "next_sequence").toString(),
      session,
      toolCallViews,
      turns,
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
      !hasExactKeys(exported, [
        "artifacts",
        "bindings",
        "commandReceipts",
        "events",
        "interactions",
        "minimumSequence",
        "nativeHistory",
        "nextSequence",
        "session",
        "toolCallViews",
        "turns",
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
    const bindingValues = exported["bindings"];
    const commandReceiptValues = exported["commandReceipts"];
    const eventValues = exported["events"];
    const interactionValues = exported["interactions"];
    const commandValues = exported["turns"];
    const activityValues = exported["toolCallViews"];
    const artifactValues = exported["artifacts"];
    const nativeHistoryValue = exported["nativeHistory"];
    if (
      !isRecord(sourceSession) ||
      !Array.isArray(bindingValues) ||
      !Array.isArray(commandReceiptValues) ||
      !Array.isArray(eventValues) ||
      !Array.isArray(interactionValues) ||
      !Array.isArray(commandValues) ||
      !Array.isArray(activityValues) ||
      !Array.isArray(artifactValues) ||
      eventValues.length > 100_000 ||
      commandValues.length > 10_000 ||
      activityValues.length > 100_000 ||
      artifactValues.length > 100_000 ||
      bindingValues.length > 10_000 ||
      commandReceiptValues.length > 10_000 ||
      interactionValues.length > 100_000
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
        "createdBy",
        "defaultBinding",
        "hasNativeHistory",
        "lastCommittedSeq",
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
      lifecycle["kind"] !== "ready"
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "Only an active session can be imported",
      );
    }
    const sessionId = importIdentifier(sourceSession, "sessionId");
    const runtimeId = importIdentifier(sourceSession, "runtimeId");
    const agentId = importIdentifier(sourceSession, "agentId");
    const createdBy = importIdentifier(sourceSession, "createdBy");
    const defaultBinding = sourceSession["defaultBinding"];
    if (!isRecord(defaultBinding)) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported default binding is invalid",
      );
    }
    let decodedDefaultBinding: SessionBinding;
    try {
      decodedDefaultBinding = decodeSessionBinding(defaultBinding);
    } catch (cause) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported default binding is invalid",
        { cause },
      );
    }
    const sourceTenantId = importIdentifier(sourceSession, "tenantId");
    const sourceProjectId = importIdentifier(sourceSession, "projectId");
    importTimestamp(sourceSession, "createdAt");
    importTimestamp(sourceSession, "updatedAt");
    const bindingId = decodedDefaultBinding.bindingId;
    const directoryId = decodedDefaultBinding.workspaceRef;
    const bindings: SessionBinding[] = [];
    const bindingIds = new Set<string>();
    for (const value of bindingValues) {
      let binding: SessionBinding;
      try {
        binding = decodeSessionBinding(value);
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported SessionBinding is invalid",
          { cause },
        );
      }
      if (
        binding.sessionId !== sessionId ||
        bindingIds.has(binding.bindingId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported SessionBinding is invalid",
        );
      }
      bindingIds.add(binding.bindingId);
      bindings.push(binding);
    }
    if (
      !bindingIds.has(bindingId) ||
      decodedDefaultBinding.sessionId !== sessionId ||
      decodedDefaultBinding.runtimeId !== runtimeId ||
      decodedDefaultBinding.agentRef !== agentId
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported default binding is inconsistent",
      );
    }
    const title = this.importString(sourceSession, "title", 500, true);
    let nativeHistory: NativeSessionHistory | null = null;
    let nativeHistoryByteLength = 0;
    if (nativeHistoryValue !== null) {
      try {
        nativeHistory = decodeNativeSessionHistory(nativeHistoryValue);
        nativeHistoryByteLength = new TextEncoder().encode(
          JSON.stringify(nativeHistory),
        ).byteLength;
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "The exported native Session history is invalid",
          { cause },
        );
      }
    }
    if (sourceSession["hasNativeHistory"] !== (nativeHistory !== null)) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported native Session history is inconsistent",
      );
    }
    const policy = sourceSession["policy"];
    if (
      !isRecord(policy) ||
      !hasExactKeys(policy, [
        "contentLimitBytes",
        "hotEventLimit",
        "idempotencyRetentionMilliseconds",
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
    const idempotencyRetentionMilliseconds =
      policy["idempotencyRetentionMilliseconds"];
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
      typeof idempotencyRetentionMilliseconds !== "number" ||
      !Number.isSafeInteger(idempotencyRetentionMilliseconds) ||
      idempotencyRetentionMilliseconds < 60_000 ||
      idempotencyRetentionMilliseconds > retentionMilliseconds ||
      typeof contentLimitBytes !== "number" ||
      !Number.isSafeInteger(contentLimitBytes) ||
      contentLimitBytes < 1_024 ||
      contentLimitBytes > DEFAULT_CONTENT_LIMIT_BYTES ||
      nativeHistoryByteLength > contentLimitBytes
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session policy is invalid",
      );
    }
    const minimumSequence = exported["minimumSequence"];
    const nextSequence = exported["nextSequence"];
    const minimumSequenceNumber =
      typeof minimumSequence === "string" &&
      DECIMAL_SEQUENCE_PATTERN.test(minimumSequence)
        ? Number(minimumSequence)
        : Number.NaN;
    const nextSequenceNumber =
      typeof nextSequence === "string" &&
      DECIMAL_SEQUENCE_PATTERN.test(nextSequence)
        ? Number(nextSequence)
        : Number.NaN;
    if (
      !Number.isSafeInteger(minimumSequenceNumber) ||
      minimumSequenceNumber < 1 ||
      !Number.isSafeInteger(nextSequenceNumber) ||
      nextSequenceNumber < minimumSequenceNumber
    ) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported event range is invalid",
      );
    }

    const events: CommittedSessionEvent[] = [];
    const decodedEvents = new Map<number, RecordedSessionEvent>();
    const eventPayloadHashes = new Map<string, string>();
    const eventIds = new Set<string>();
    let expectedSequence = minimumSequenceNumber;
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
      const committedSequence = Number(committed.sequence);
      if (
        committed.sessionId !== sessionId ||
        !Number.isSafeInteger(committedSequence) ||
        committedSequence.toString() !== committed.sequence ||
        committedSequence !== expectedSequence ||
        eventIds.has(committed.eventId)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "The exported event sequence is invalid",
        );
      }
      eventIds.add(committed.eventId);
      events.push(committed);
      eventPayloadHashes.set(
        committed.eventId,
        await sha256(new TextEncoder().encode(committed.payload)),
      );
      decodedEvents.set(committedSequence, decodedEvent);
      expectedSequence += 1;
    }
    if (expectedSequence !== nextSequenceNumber) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported event range is incomplete",
      );
    }

    const commands: ImportedCommand[] = [];
    const commandIds = new Set<string>();
    const commandsByIdempotencyKey = new Map<string, ImportedCommand>();
    const commandsByTurnId = new Map<string, ImportedCommand>();
    const attemptIds = new Set<string>();
    const attemptIdsByCommand = new Map<string, string>();
    for (const value of commandValues) {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "command",
          "createdAt",
          "response",
          "state",
          "turn",
          "updatedAt",
        ])
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command is invalid",
        );
      }
      let command: SessionPromptCommand;
      let turn: Turn;
      try {
        command = decodeSessionPromptCommand(JSON.stringify(value["command"]));
        turn = decodeTurn(value["turn"]);
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
        turn.sessionId !== sessionId ||
        turn.idempotencyKey !== command.commandId ||
        turn.bindingId !== command.bindingId ||
        !bindingIds.has(turn.bindingId) ||
        turn.request.kind !== "prompt" ||
        turn.request.content !== command.prompt ||
        commandIds.has(command.commandId) ||
        !isRecord(stateValue)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command is invalid",
        );
      }
      commandIds.add(command.commandId);
      const requestHash = await sha256(
        new TextEncoder().encode(JSON.stringify(command)),
      );
      let state: ImportedCommand["state"];
      let attemptId: string | null = null;
      let startedAt: number | null = null;
      let completedAt: number | null = null;
      let stopReason: string | null = null;
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      const kind = stateValue["kind"];
      if (kind === "queued" && hasExactKeys(stateValue, ["kind"])) {
        state = "queued";
      } else if (
        kind === "running" &&
        hasExactKeys(stateValue, ["kind", "attemptId", "startedAt"])
      ) {
        state = "running";
        attemptId = importIdentifier(stateValue, "attemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
      } else if (
        kind === "succeeded" &&
        hasExactKeys(stateValue, [
          "completedAt",
          "kind",
          "attemptId",
          "startedAt",
          "stopReason",
        ])
      ) {
        state = "succeeded";
        attemptId = importIdentifier(stateValue, "attemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
        completedAt = importTimestamp(stateValue, "completedAt");
        stopReason = this.importString(stateValue, "stopReason", 128, true);
      } else if (
        kind === "indeterminate" &&
        hasExactKeys(stateValue, [
          "detectedAt",
          "kind",
          "attemptId",
          "startedAt",
        ])
      ) {
        state = "indeterminate";
        attemptId = importIdentifier(stateValue, "attemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
      } else if (
        kind === "cancelled" &&
        hasExactKeys(stateValue, [
          "attemptId",
          "cancelledAt",
          "kind",
          "startedAt",
        ])
      ) {
        state = "cancelled";
        attemptId = importIdentifier(stateValue, "attemptId");
        startedAt = importTimestamp(stateValue, "startedAt");
        completedAt = importTimestamp(stateValue, "cancelledAt");
        stopReason = "cancelled";
      } else if (
        kind === "failed" &&
        hasExactKeys(stateValue, [
          "code",
          "failedAt",
          "kind",
          "message",
          "attemptId",
          "startedAt",
        ])
      ) {
        state = "failed";
        completedAt = importTimestamp(stateValue, "failedAt");
        errorCode = this.importString(stateValue, "code", 128);
        errorMessage = this.importString(stateValue, "message", 2_000, true);
        const processValue = stateValue["attemptId"];
        const startedValue = stateValue["startedAt"];
        if (processValue === null && startedValue === null) {
          attemptId = null;
          startedAt = null;
        } else if (
          typeof processValue === "string" &&
          typeof startedValue === "string"
        ) {
          attemptId = importIdentifier(stateValue, "attemptId");
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
        bindingId: turn.bindingId,
        command,
        completedAt,
        createdAt,
        errorCode,
        errorMessage,
        idempotencyKey: turn.idempotencyKey,
        attemptId,
        requestHash,
        response,
        startedAt,
        state,
        stopReason,
        turnId: turn.turnId,
        updatedAt,
      });
      const imported = commands.at(-1);
      if (imported === undefined) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported command could not be retained",
        );
      }
      commandsByIdempotencyKey.set(imported.idempotencyKey, imported);
      commandsByTurnId.set(imported.turnId, imported);
      if (attemptId !== null) {
        attemptIdsByCommand.set(command.commandId, attemptId);
        attemptIds.add(attemptId);
      }
    }
    const commandReceipts: CommandReceipt[] = [];
    const receiptKeys = new Set<string>();
    for (const value of commandReceiptValues) {
      let receipt: CommandReceipt;
      try {
        receipt = decodeCommandReceipt(value);
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported CommandReceipt is invalid",
          { cause },
        );
      }
      const command = commandsByIdempotencyKey.get(receipt.idempotencyKey);
      if (
        receipt.tenantId !== sourceTenantId ||
        receipt.projectId !== sourceProjectId ||
        receipt.sessionId !== sessionId ||
        receipt.commandKind !== SESSION_PROMPT_KIND ||
        command === undefined ||
        receipt.resultId !== command.turnId ||
        receipt.requestHash !== command.requestHash ||
        Date.parse(receipt.acceptedAt) !== command.createdAt ||
        Date.parse(receipt.expiresAt) !==
          command.createdAt + idempotencyRetentionMilliseconds ||
        receiptKeys.has(receipt.idempotencyKey)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported CommandReceipt is inconsistent",
        );
      }
      receiptKeys.add(receipt.idempotencyKey);
      commandReceipts.push(receipt);
    }
    if (commandReceipts.length !== commands.length) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported CommandReceipt set is incomplete",
      );
    }
    const interactions: Interaction[] = [];
    const interactionIds = new Set<string>();
    for (const value of interactionValues) {
      let interaction: Interaction;
      try {
        interaction = decodeInteraction(value);
      } catch (cause) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported Interaction is invalid",
          { cause },
        );
      }
      const owningCommand = commandsByTurnId.get(interaction.turnId);
      if (
        interaction.sessionId !== sessionId ||
        owningCommand?.attemptId !== interaction.attemptId ||
        !attemptIds.has(interaction.attemptId) ||
        interactionIds.has(interaction.interactionId) ||
        interaction.state.kind === "pending" ||
        interaction.state.kind === "responded"
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported Interaction is inconsistent",
        );
      }
      interactionIds.add(interaction.interactionId);
      interactions.push(interaction);
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
    const toolCallKeys = new Set<string>();
    for (const value of activityValues) {
      const eventSequence =
        isRecord(value) &&
        typeof value["eventSequence"] === "string" &&
        DECIMAL_SEQUENCE_PATTERN.test(value["eventSequence"])
          ? Number(value["eventSequence"])
          : Number.NaN;
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ["attemptId", "event", "eventSequence"]) ||
        !Number.isSafeInteger(eventSequence) ||
        eventSequence < 1 ||
        eventSequence >= nextSequenceNumber
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity is invalid",
        );
      }
      const attemptId = importIdentifier(value, "attemptId");
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
      const toolCallKey = `${attemptId}\u0000${
        event.kind === AGENT_ACTIVITY_KIND ? event.activityId : ""
      }`;
      if (
        event.kind !== AGENT_ACTIVITY_KIND ||
        event.sessionId !== sessionId ||
        event.detail.kind === "recorded" ||
        !commandIds.has(event.commandId) ||
        attemptIdsByCommand.get(event.commandId) !== attemptId ||
        toolCallKeys.has(toolCallKey)
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An exported activity is invalid",
        );
      }
      const retainedEvent = decodedEvents.get(eventSequence);
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
      toolCallKeys.add(toolCallKey);
      activities.push({
        attemptId,
        event,
        eventSequence,
      });
    }

    const artifacts = new Map<
      string,
      {
        readonly attemptId: string;
        readonly payload: string;
        readonly toolCallId: string;
      }
    >();
    let artifactBytes = 0;
    for (const value of artifactValues) {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "attemptId",
          "artifactId",
          "byteLength",
          "contentBase64",
          "contentEncoding",
          "mediaType",
          "sha256",
          "toolCallId",
        ])
      ) {
        throw new SessionRuntimeError(
          "invalid_export",
          "An export artifact is invalid",
        );
      }
      const attemptId = importIdentifier(value, "attemptId");
      const toolCallId = importIdentifier(value, "toolCallId");
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
        !toolCallKeys.has(`${attemptId}\u0000${toolCallId}`)
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
      artifacts.set(artifactId, { attemptId, payload, toolCallId });
    }
    const referencedArtifacts = new Set<string>();
    for (const activity of activities) {
      if (activity.event.detail.kind !== "available") {
        continue;
      }
      const artifact = artifacts.get(activity.event.detail.artifactId);
      if (
        artifact?.attemptId !== activity.attemptId ||
        artifact.toolCallId !== activity.event.activityId
      ) {
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
          {
            contentLimitBytes,
            hotEventLimit,
            idempotencyRetentionMilliseconds,
            level,
            retentionMilliseconds,
          },
          title,
          createdBy,
        ),
        now,
        signal,
      );
      created = true;
      signal.throwIfAborted();
      this.#database.transaction(() => {
        if (nativeHistory !== null) {
          this.#database.run(
            `UPDATE sessions SET native_history_json = ?
             WHERE scope_key = ? AND session_id = ?`,
            [JSON.stringify(nativeHistory), key, sessionId],
          );
        }
        for (const binding of bindings) {
          if (binding.bindingId === bindingId) {
            continue;
          }
          this.#database.run(
            `INSERT INTO session_bindings (
               scope_key, session_id, binding_id, runtime_id, agent_ref,
               workspace_ref, config_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              binding.bindingId,
              binding.runtimeId,
              binding.agentRef,
              binding.workspaceRef,
              binding.configRevision,
              Date.parse(binding.createdAt),
            ],
          );
        }
        for (const command of commands) {
          this.#database.run(
            `INSERT INTO turns (
               scope_key, session_id, command_id, turn_id, binding_id,
               idempotency_key, request_hash, command_json, state,
               response, attempt_id, started_at, completed_at,
               stop_reason, error_code, error_message, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              command.command.commandId,
              command.turnId,
              command.bindingId,
              command.idempotencyKey,
              command.requestHash,
              JSON.stringify(command.command),
              command.state,
              command.response,
              command.attemptId,
              command.startedAt,
              command.completedAt,
              command.stopReason,
              command.errorCode,
              command.errorMessage,
              command.createdAt,
              command.updatedAt,
            ],
          );
          this.#database.run(
            `INSERT INTO command_receipts (
               scope_key, session_id, command_kind, idempotency_key,
               request_hash, result_id, accepted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              command.command.kind,
              command.idempotencyKey,
              command.requestHash,
              command.turnId,
              command.createdAt,
            ],
          );
          if (command.attemptId !== null && command.startedAt !== null) {
            this.#database.run(
              `INSERT INTO attempts (
                 scope_key, session_id, attempt_id, turn_id, binding_id,
                 state, started_at, completed_at, stop_reason, error_code,
                 error_message, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                key,
                sessionId,
                command.attemptId,
                command.turnId,
                command.bindingId,
                command.state,
                command.startedAt,
                command.completedAt,
                command.stopReason,
                command.errorCode,
                command.errorMessage,
                command.updatedAt,
              ],
            );
          }
        }
        for (const interaction of interactions) {
          let responseJson: string | null = null;
          let responderId: string | null = null;
          let respondedAt: number | null = null;
          let resolvedAt: number;
          switch (interaction.state.kind) {
            case "resolved": {
              resolvedAt = Date.parse(interaction.state.resolvedAt);
              if (interaction.state.resolution.kind === "response_applied") {
                responseJson = JSON.stringify(
                  interaction.state.resolution.response,
                );
                responderId = interaction.state.resolution.responderId;
                respondedAt = Date.parse(
                  interaction.state.resolution.respondedAt,
                );
              }
              break;
            }
            case "expired":
              resolvedAt = Date.parse(interaction.state.expiredAt);
              break;
            case "cancelled":
              resolvedAt = Date.parse(interaction.state.cancelledAt);
              break;
            case "pending":
            case "responded":
              throw new SessionRuntimeError(
                "invalid_export",
                "An imported Interaction cannot schedule executable work",
              );
          }
          this.#database.run(
            `INSERT INTO interactions (
               scope_key, session_id, interaction_id, turn_id, attempt_id,
               request_json, state, response_json, responder_id, responded_at,
               resolved_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              interaction.interactionId,
              interaction.turnId,
              interaction.attemptId,
              JSON.stringify(interaction.request),
              interaction.state.kind,
              responseJson,
              responderId,
              respondedAt,
              resolvedAt,
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
            `INSERT INTO tool_call_views (
               scope_key, session_id, command_id, attempt_id, activity_id, summary_json,
               detail_kind, detail_artifact_id, hot_detail, captured_bytes,
               original_bytes, event_sequence
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              activity.event.commandId,
              activity.attemptId,
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
            if (
              artifact.attemptId !== activity.attemptId ||
              artifact.toolCallId !== activity.event.activityId
            ) {
              throw new SessionRuntimeError(
                "invalid_export",
                "An export artifact belongs to another ToolCall",
              );
            }
            this.queueArtifactArchive(
              key,
              sessionId,
              artifactId,
              activity.event.activityId,
              "application/json",
              artifact.payload,
            );
          }
        }
        for (const committed of events) {
          const archiveSegmentId = `segment-${committed.eventId}`;
          this.queueEventArchive(
            key,
            sessionId,
            archiveSegmentId,
            committed.eventId,
            Number(committed.sequence),
            "application/json",
            committed.payload,
          );
          this.#database.run(
            `INSERT INTO session_events (
               scope_key, session_id, sequence_number, event_id, payload_hash,
               source_kind, source_id, source_seq, payload, archive_segment_id,
               recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              key,
              sessionId,
              Number(committed.sequence),
              committed.eventId,
              eventPayloadHashes.get(committed.eventId) ?? "",
              committed.source.kind,
              committed.source.kind === "attempt"
                ? committed.source.attemptId
                : runtimeId,
              committed.source.sourceSeq,
              committed.payload,
              archiveSegmentId,
              Date.parse(committed.recordedAt),
            ],
          );
        }
        this.#database.run(
          `UPDATE sessions
           SET minimum_sequence = ?, next_sequence = ?, updated_at = ?
           WHERE scope_key = ? AND session_id = ?`,
          [minimumSequenceNumber, nextSequenceNumber, now, key, sessionId],
        );
      });
      signal.throwIfAborted();
    } catch (error) {
      if (created) {
        this.#database.transaction(() => {
          for (const table of [
            "archive_work",
            "archive_segments",
            "artifacts",
            "tool_call_views",
            "pending_work",
            "interactions",
            "session_events",
            "attempts",
            "command_receipts",
            "turns",
            "session_bindings",
            "sessions",
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
      `SELECT target_id FROM archive_work
       WHERE scope_key = ? AND session_id = ? LIMIT 1`,
      [scopeKey(scope), sessionId],
    )[0] !== undefined;

  private readonly assertSessionQuota = (scope: ProjectScope): void => {
    const tenant = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM sessions
       WHERE tenant_id = ? AND lifecycle <> 'deleted'`,
      [scope.tenantId],
    )[0];
    const project = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM sessions
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
        `SELECT * FROM sessions
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
    if (activeOnly && rowString(row, "lifecycle") !== "ready") {
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
        `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
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
      `SELECT * FROM turns
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
    attemptSourceId: string | null,
    now: number,
  ): void => {
    const event = prepared.event;
    if (event.kind === SESSION_STARTED_KIND) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["queued"],
      );
      this.#database.run(
        `INSERT INTO attempts (
           scope_key, session_id, attempt_id, turn_id, binding_id, state,
           started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        [
          key,
          sessionId,
          event.attemptId,
          rowString(command, "turn_id"),
          rowString(command, "binding_id"),
          now,
          now,
        ],
      );
      this.#database.run(
        `UPDATE turns
         SET state = 'running', attempt_id = ?, started_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [event.attemptId, now, now, key, sessionId, event.commandId],
      );
      return;
    }
    if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, ["running"]);
      this.#database.run(
        `UPDATE turns
         SET response = substr(response || ?, 1, 100000), updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [event.text, now, key, sessionId, event.commandId],
      );
      return;
    }
    if (event.kind === AGENT_ACTIVITY_KIND) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["running"],
      );
      const attemptId = rowNullableString(command, "attempt_id");
      if (attemptId === null) {
        throw new SessionRuntimeError(
          "session_conflict",
          "The ToolCall has no owning Attempt",
        );
      }
      const sequenceRow = this.#database.query(
        `SELECT next_sequence FROM sessions
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
        `INSERT INTO tool_call_views (
           scope_key, session_id, command_id, attempt_id, activity_id, summary_json,
           detail_kind, detail_artifact_id, hot_detail, captured_bytes,
           original_bytes, event_sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, session_id, attempt_id, activity_id) DO UPDATE SET
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
          attemptId,
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
    if (
      event.kind === SESSION_PERMISSION_REQUESTED_KIND ||
      event.kind === SESSION_ELICITATION_REQUESTED_KIND
    ) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["running"],
      );
      const attemptId = rowNullableString(command, "attempt_id");
      if (attemptId === null) {
        throw new SessionRuntimeError(
          "session_conflict",
          "The running Turn has no Attempt identity",
        );
      }
      const attempt = this.#database.query(
        `SELECT * FROM attempts
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
        [key, sessionId, attemptId],
      )[0];
      if (
        attempt === undefined ||
        !["running", "waiting_input"].includes(rowString(attempt, "state"))
      ) {
        throw new SessionRuntimeError(
          "session_conflict",
          "The Interaction does not belong to a live Attempt",
        );
      }
      const request: Interaction["request"] =
        event.kind === SESSION_PERMISSION_REQUESTED_KIND
          ? {
              kind: "permission",
              options: event.options,
              title: event.title,
              toolCallId: event.toolCallId,
              toolKind: event.toolKind,
            }
          : {
              elicitationId: event.elicitationId,
              fields: event.fields,
              kind: "elicitation",
              message: event.message,
              mode: event.mode,
              url: event.url,
            };
      const requestJson = JSON.stringify(request);
      const existing = this.#database.query(
        `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [key, sessionId, event.interactionId],
      )[0];
      if (existing !== undefined) {
        if (
          rowString(existing, "turn_id") !== rowString(command, "turn_id") ||
          rowString(existing, "attempt_id") !== attemptId ||
          rowString(existing, "request_json") !== requestJson
        ) {
          throw new SessionRuntimeError(
            "interaction_conflict",
            "The Interaction identity was reused with different input",
          );
        }
        return;
      }
      this.#database.run(
        `INSERT INTO interactions (
           scope_key, session_id, interaction_id, turn_id, attempt_id,
           request_json, state
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [
          key,
          sessionId,
          event.interactionId,
          rowString(command, "turn_id"),
          attemptId,
          requestJson,
        ],
      );
      const interactionIds = [
        ...identifierArrayFromJson(
          rowString(attempt, "waiting_interaction_ids_json"),
          "waiting Interaction",
        ),
        event.interactionId,
      ];
      this.#database.run(
        `UPDATE attempts
         SET state = 'waiting_input', waiting_interaction_ids_json = ?,
             updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
        [JSON.stringify(interactionIds), now, key, sessionId, attemptId],
      );
      return;
    }
    if (
      event.kind === SESSION_PERMISSION_RESOLVED_KIND ||
      event.kind === SESSION_ELICITATION_RESOLVED_KIND
    ) {
      const interaction = this.#database.query(
        `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [key, sessionId, event.interactionId],
      )[0];
      if (interaction === undefined) {
        throw new SessionRuntimeError(
          "interaction_not_found",
          "The Runtime resolved an unknown Interaction",
        );
      }
      const interactionState = rowString(interaction, "state");
      const interactionRequest = interactionFromRow(interaction).request;
      const urlElicitation =
        interactionRequest.kind === "elicitation" &&
        interactionRequest.mode === "url";
      if (
        event.kind === SESSION_ELICITATION_RESOLVED_KIND &&
        event.action === "accept" &&
        urlElicitation
      ) {
        if (interactionState !== "responded") {
          throw new SessionRuntimeError(
            "interaction_conflict",
            "The URL elicitation response was not accepted",
          );
        }
        return;
      }
      if (
        event.kind === SESSION_ELICITATION_RESOLVED_KIND &&
        event.action === "complete" &&
        (!urlElicitation || interactionState !== "responded")
      ) {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "Only an accepted URL elicitation can complete out of band",
        );
      }
      if (interactionState !== "pending" && interactionState !== "responded") {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "The Interaction is already terminal",
        );
      }
      this.#database.run(
        `UPDATE interactions
         SET state = 'resolved', resolved_at = ?
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [now, key, sessionId, event.interactionId],
      );
      const attemptId = rowString(interaction, "attempt_id");
      const remaining = this.#database.query(
        `SELECT interaction_id FROM interactions
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
           AND state IN ('pending', 'responded')
         ORDER BY interaction_id`,
        [key, sessionId, attemptId],
      );
      const remainingIds = remaining.map((row) =>
        rowString(row, "interaction_id"),
      );
      this.#database.run(
        `UPDATE attempts
         SET state = ?, waiting_interaction_ids_json = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
           AND state IN ('running', 'waiting_input')`,
        [
          remainingIds.length === 0 ? "running" : "waiting_input",
          JSON.stringify(remainingIds),
          now,
          key,
          sessionId,
          attemptId,
        ],
      );
      return;
    }
    if (event.kind === SESSION_COMPLETED_KIND) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["running"],
      );
      this.#database.run(
        `UPDATE turns
         SET state = ?, completed_at = ?, stop_reason = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [
          event.stopReason === "cancelled" ? "cancelled" : "succeeded",
          now,
          event.stopReason,
          now,
          key,
          sessionId,
          event.commandId,
        ],
      );
      this.#database.run(
        `UPDATE attempts
         SET state = ?, completed_at = ?, stop_reason = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('running', 'waiting_input')`,
        [
          event.stopReason === "cancelled" ? "cancelled" : "succeeded",
          now,
          event.stopReason,
          now,
          key,
          sessionId,
          rowString(command, "turn_id"),
        ],
      );
      this.#database.run(
        `UPDATE interactions
         SET state = 'cancelled', resolved_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('pending', 'responded')`,
        [now, key, sessionId, rowString(command, "turn_id")],
      );
      return;
    }
    if (event.kind === SESSION_FAILED_KIND) {
      const command = this.requireCommandState(
        key,
        sessionId,
        event.commandId,
        ["queued", "running"],
      );
      if (rowString(command, "state") === "queued") {
        if (attemptSourceId === null) {
          throw new SessionRuntimeError(
            "event_source_conflict",
            "A failed dispatch has no Attempt source identity",
          );
        }
        this.#database.run(
          `INSERT INTO attempts (
             scope_key, session_id, attempt_id, turn_id, binding_id, state,
             started_at, completed_at, error_code, error_message, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
          [
            key,
            sessionId,
            attemptSourceId,
            rowString(command, "turn_id"),
            rowString(command, "binding_id"),
            now,
            now,
            event.code,
            event.message,
            now,
          ],
        );
      }
      this.#database.run(
        `UPDATE turns
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, attempt_id = COALESCE(attempt_id, ?),
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
        [
          now,
          event.code,
          event.message,
          attemptSourceId,
          now,
          now,
          key,
          sessionId,
          rowString(command, "command_id"),
        ],
      );
      this.#database.run(
        `UPDATE attempts
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('running', 'waiting_input')`,
        [
          now,
          event.code,
          event.message,
          now,
          key,
          sessionId,
          rowString(command, "turn_id"),
        ],
      );
      this.#database.run(
        `UPDATE interactions
         SET state = 'cancelled', resolved_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('pending', 'responded')`,
        [now, key, sessionId, rowString(command, "turn_id")],
      );
      return;
    }
    if (event.kind === SESSION_CONFIG_UPDATED_KIND) {
      const session = this.#database.query(
        `SELECT runtime_id, agent_id, directory_id, binding_id, config_revision
         FROM sessions WHERE scope_key = ? AND session_id = ?`,
        [key, sessionId],
      )[0];
      if (session === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The Session configuration binding is unavailable",
        );
      }
      const existing = this.#database.query(
        `SELECT runtime_id, agent_ref, workspace_ref, config_revision
         FROM session_bindings
         WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
        [key, sessionId, event.requestId],
      )[0];
      const configRevision = rowNumber(session, "config_revision") + 1;
      if (existing !== undefined) {
        if (
          rowString(existing, "runtime_id") !==
            rowString(session, "runtime_id") ||
          rowString(existing, "agent_ref") !== rowString(session, "agent_id") ||
          rowString(existing, "workspace_ref") !==
            rowString(session, "directory_id") ||
          rowNumber(existing, "config_revision") !== configRevision
        ) {
          throw new SessionRuntimeError(
            "session_conflict",
            "The configuration request identity is already a different binding",
          );
        }
      } else {
        this.#database.run(
          `INSERT INTO session_bindings (
             scope_key, session_id, binding_id, runtime_id, agent_ref,
             workspace_ref, config_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            sessionId,
            event.requestId,
            rowString(session, "runtime_id"),
            rowString(session, "agent_id"),
            rowString(session, "directory_id"),
            configRevision,
            now,
          ],
        );
      }
      this.#database.run(
        `UPDATE sessions
         SET binding_id = ?, config_revision = ?, binding_created_at = ?,
             updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
        [event.requestId, configRevision, now, now, key, sessionId],
      );
      return;
    }
    if (event.kind === SESSION_INFO_UPDATED_KIND) {
      this.#database.run(
        `UPDATE sessions SET title = ?, updated_at = ?
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
       FROM archive_work
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

  private readonly queueArtifactArchive = (
    key: string,
    sessionId: string,
    artifactId: string,
    ownerId: string,
    mediaType: string,
    hotPayload: string,
  ): void => {
    const bytes = new TextEncoder().encode(hotPayload);
    this.#database.run(
      `INSERT INTO artifacts (
         scope_key, session_id, artifact_id, owner_id, media_type, state,
         byte_length, sha256, chunks_json
       ) VALUES (?, ?, ?, ?, ?, 'uploading', ?, '', NULL)
       ON CONFLICT(scope_key, session_id, artifact_id) DO NOTHING`,
      [key, sessionId, artifactId, ownerId, mediaType, bytes.byteLength],
    );
    this.queueArchiveWork(
      key,
      sessionId,
      artifactId,
      "activity",
      ownerId,
      mediaType,
      hotPayload,
    );
  };

  private readonly queueEventArchive = (
    key: string,
    sessionId: string,
    segmentId: string,
    eventId: string,
    sequence: number,
    mediaType: string,
    hotPayload: string,
  ): void => {
    const bytes = new TextEncoder().encode(hotPayload);
    this.#database.run(
      `INSERT INTO archive_segments (
         scope_key, session_id, segment_id, first_sequence, last_sequence,
         event_count, media_type, state, byte_length, sha256, chunks_json
       ) VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', ?, '', NULL)
       ON CONFLICT(scope_key, session_id, segment_id) DO NOTHING`,
      [
        key,
        sessionId,
        segmentId,
        sequence,
        sequence,
        mediaType,
        bytes.byteLength,
      ],
    );
    this.queueArchiveWork(
      key,
      sessionId,
      segmentId,
      "event",
      eventId,
      mediaType,
      hotPayload,
    );
  };

  private readonly queueArchiveWork = (
    key: string,
    sessionId: string,
    targetId: string,
    archiveKind: "activity" | "event",
    ownerId: string,
    mediaType: string,
    hotPayload: string,
  ): void => {
    this.#database.run(
      `INSERT INTO archive_work (
         scope_key, session_id, target_id, archive_kind, owner_id,
         media_type, hot_payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, session_id, target_id) DO NOTHING`,
      [key, sessionId, targetId, archiveKind, ownerId, mediaType, hotPayload],
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
      agentId: command.agentId,
      attempt: this.attemptFromRow(row),
      commandId: command.commandId,
      createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
      images: command.images,
      prompt: command.prompt,
      resources: command.resources,
      response: rowString(row, "response"),
      sessionId,
    };
  };

  private readonly attemptFromRow = (
    row: SessionSqlRow,
  ): AttemptSummary | null => {
    const state = rowString(row, "state");
    if (state === "queued") {
      return null;
    }
    const attemptId = rowNullableString(row, "attempt_id");
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
        attemptId,
        startedAt,
      };
    }
    if (attemptId === null || startedAt === null) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The stored attempt is incomplete",
      );
    }
    if (state === "running") {
      return { kind: "running", attemptId, startedAt };
    }
    if (state === "indeterminate") {
      return {
        detectedAt: new Date(rowNumber(row, "updated_at")).toISOString(),
        kind: "indeterminate",
        attemptId,
        startedAt,
      };
    }
    if (state === "succeeded") {
      const completedAt = Reflect.get(row, "completed_at");
      if (typeof completedAt !== "number") {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The stored completion is incomplete",
        );
      }
      return {
        completedAt: new Date(completedAt).toISOString(),
        kind: "succeeded",
        attemptId,
        startedAt,
        stopReason: rowNullableString(row, "stop_reason") ?? "unknown",
      };
    }
    if (state === "cancelled") {
      return {
        attemptId,
        cancelledAt: new Date(rowNumber(row, "completed_at")).toISOString(),
        kind: "cancelled",
        startedAt,
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
    const targetId = rowString(job, "target_id");
    const payload = rowString(job, "hot_payload");
    const mediaType = rowString(job, "media_type");
    const bytes = new TextEncoder().encode(payload);
    const segments: StoredArchiveChunk[] = [];
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
      const chunkId = `${targetId}.${index.toString().padStart(6, "0")}`;
      const digest = await sha256(compressed);
      await this.#content.write(
        new ContentTarget(scope.tenantId, scope.projectId, sessionId, chunkId),
        {
          bytes: compressed,
          contentEncoding: "gzip",
          mediaType,
          sha256: digest,
        },
        signal,
      );
      segments.push({
        artifactId: chunkId,
        byteLength: uncompressed.byteLength,
        sha256: digest,
        storedByteLength: compressed.byteLength,
      });
    }
    const digest = await sha256(bytes);
    this.#database.transaction(() => {
      const current = this.#database.query(
        `SELECT target_id FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
        [scopeKey(scope), sessionId, targetId],
      )[0];
      if (current === undefined) {
        return;
      }
      const manifestValues: readonly SessionSqlValue[] = [
        bytes.byteLength,
        digest,
        JSON.stringify(segments),
        scopeKey(scope),
        sessionId,
        targetId,
      ];
      if (rowString(job, "archive_kind") === "event") {
        this.#database.run(
          `UPDATE archive_segments
           SET state = 'published', byte_length = ?, sha256 = ?, chunks_json = ?
           WHERE scope_key = ? AND session_id = ? AND segment_id = ?
             AND state = 'pending'`,
          manifestValues,
        );
      } else {
        this.#database.run(
          `UPDATE artifacts
           SET state = 'available', byte_length = ?, sha256 = ?, chunks_json = ?
           WHERE scope_key = ? AND session_id = ? AND artifact_id = ?
             AND state = 'uploading'`,
          manifestValues,
        );
      }
      this.#database.run(
        `DELETE FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
        [scopeKey(scope), sessionId, targetId],
      );
      if (rowString(job, "archive_kind") === "event") {
        this.#database.run(
          `UPDATE session_events SET payload = NULL
           WHERE scope_key = ? AND session_id = ? AND archive_segment_id = ?`,
          [scopeKey(scope), sessionId, targetId],
        );
      } else {
        this.#database.run(
          `UPDATE tool_call_views SET hot_detail = NULL
           WHERE scope_key = ? AND session_id = ? AND detail_artifact_id = ?`,
          [scopeKey(scope), sessionId, targetId],
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
      `SELECT state, byte_length, sha256, chunks_json FROM artifacts
       WHERE scope_key = ? AND session_id = ? AND artifact_id = ?`,
      [scopeKey(scope), sessionId, artifactId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "artifact_not_found",
        "The archive does not exist",
      );
    }
    return await this.readArchivedPayload(
      scope,
      sessionId,
      artifactId,
      row,
      rowString(row, "state") === "available",
      signal,
    );
  };

  private readonly readArchiveSegment = async (
    scope: ProjectScope,
    sessionId: string,
    segmentId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const row = this.#database.query(
      `SELECT state, byte_length, sha256, chunks_json FROM archive_segments
       WHERE scope_key = ? AND session_id = ? AND segment_id = ?`,
      [scopeKey(scope), sessionId, segmentId],
    )[0];
    if (row === undefined) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The event archive segment does not exist",
      );
    }
    return await this.readArchivedPayload(
      scope,
      sessionId,
      segmentId,
      row,
      rowString(row, "state") === "published",
      signal,
    );
  };

  private readonly readArchivedPayload = async (
    scope: ProjectScope,
    sessionId: string,
    targetId: string,
    row: SessionSqlRow,
    published: boolean,
    signal: AbortSignal,
  ): Promise<string> => {
    const chunksJson = rowNullableString(row, "chunks_json");
    if (chunksJson === null) {
      const pending = this.#database.query(
        `SELECT hot_payload FROM archive_work
         WHERE scope_key = ? AND session_id = ? AND target_id = ?`,
        [scopeKey(scope), sessionId, targetId],
      )[0];
      if (pending !== undefined) {
        return rowString(pending, "hot_payload");
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive manifest is not committed",
      );
    }
    if (!published) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The archive manifest is not published",
      );
    }
    const segments = parseSegments(chunksJson);
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
      (await this.readArchiveSegment(
        scope,
        sessionId,
        rowString(row, "archive_segment_id"),
        signal,
      ))
    );
  };

  private readonly pruneArchivedEvents = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    this.requireSessionRow(scope, sessionId, false);
  };

  private readonly deleteArchivedContent = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const manifests = this.#database.query(
      `SELECT chunks_json FROM artifacts
       WHERE scope_key = ? AND session_id = ? AND chunks_json IS NOT NULL
       UNION ALL
       SELECT chunks_json FROM archive_segments
       WHERE scope_key = ? AND session_id = ? AND chunks_json IS NOT NULL`,
      [scopeKey(scope), sessionId, scopeKey(scope), sessionId],
    );
    for (const manifest of manifests) {
      await this.deleteManifestSegments(scope, sessionId, manifest, signal);
    }
    const pending = this.#database.query(
      `SELECT target_id, hot_payload FROM archive_work
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
          `${rowString(job, "target_id")}.${index.toString().padStart(6, "0")}`,
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
    const encoded = rowNullableString(manifest, "chunks_json");
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
