import {
  decodeAgentActivityEvent,
  decodeCommittedSessionEvent,
  decodeSessionPromptCommand,
  encodeSessionEventEnvelope,
  encodeSessionPromptCommand,
  type SessionEventEnvelope,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
  type ActivityDetail,
  type CommittedEventResult,
  type CreateSessionRequest,
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
  validateCreateSessionRequest,
} from "@moxt-ai/mobius-relay-core";

const SESSION_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const MAX_INTERNAL_RESPONSE_LENGTH = 96 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

interface DirectoryRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly summary_json: string;
  readonly updated_at: number;
}

type SessionReservation =
  | { readonly kind: "existing" }
  | { readonly kind: "reserved" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  allowEmpty = false,
): string {
  const field = value[key];
  if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session storage returned an invalid record",
    );
  }
  return field;
}

function readNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session storage returned an invalid record",
    );
  }
  return field;
}

function decodeLifecycle(value: unknown): SessionLifecycle {
  if (!isRecord(value)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session lifecycle is invalid",
    );
  }
  const kind = value["kind"];
  if (kind === "active") {
    return { kind };
  }
  if (kind === "deleting") {
    return { kind, requestedAt: readString(value, "requestedAt") };
  }
  if (kind === "deleted") {
    return { completedAt: readString(value, "completedAt"), kind };
  }
  throw new SessionRuntimeError(
    "session_storage_unavailable",
    "The session lifecycle is invalid",
  );
}

function decodeSummary(value: unknown): SessionSummary {
  if (!isRecord(value) || !isRecord(value["policy"])) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session summary is invalid",
    );
  }
  const policy = value["policy"];
  const level = policy["level"];
  if (level !== "full" && level !== "summary") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session policy is invalid",
    );
  }
  return {
    agentId: readString(value, "agentId"),
    createdAt: readString(value, "createdAt"),
    lifecycle: decodeLifecycle(value["lifecycle"]),
    policy: {
      contentLimitBytes: readNumber(policy, "contentLimitBytes"),
      hotEventLimit: readNumber(policy, "hotEventLimit"),
      level,
      retentionMilliseconds: readNumber(policy, "retentionMilliseconds"),
    },
    projectId: readString(value, "projectId"),
    runtimeId: readString(value, "runtimeId"),
    sessionId: readString(value, "sessionId"),
    tenantId: readString(value, "tenantId"),
    title: readString(value, "title", true),
    updatedAt: readString(value, "updatedAt"),
  };
}

function decodeAttempt(value: unknown): SessionMessage["attempt"] {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session attempt is invalid",
    );
  }
  const kind = value["kind"];
  if (kind === "running") {
    return {
      kind,
      processAttemptId: readString(value, "processAttemptId"),
      startedAt: readString(value, "startedAt"),
    };
  }
  if (kind === "completed") {
    return {
      completedAt: readString(value, "completedAt"),
      kind,
      processAttemptId: readString(value, "processAttemptId"),
      startedAt: readString(value, "startedAt"),
      stopReason: readString(value, "stopReason"),
    };
  }
  if (kind === "outcome_unknown") {
    return {
      disconnectedAt: readString(value, "disconnectedAt"),
      kind,
      processAttemptId: readString(value, "processAttemptId"),
      startedAt: readString(value, "startedAt"),
    };
  }
  if (kind === "failed") {
    const processAttemptId = value["processAttemptId"];
    const startedAt = value["startedAt"];
    if (
      (processAttemptId !== null && typeof processAttemptId !== "string") ||
      (startedAt !== null && typeof startedAt !== "string")
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The failed attempt is invalid",
      );
    }
    return {
      code: readString(value, "code"),
      failedAt: readString(value, "failedAt"),
      kind,
      message: readString(value, "message", true),
      processAttemptId,
      startedAt,
    };
  }
  throw new SessionRuntimeError(
    "session_storage_unavailable",
    "The session attempt state is invalid",
  );
}

function decodeMessage(value: unknown): SessionMessage {
  if (!isRecord(value) || !Array.isArray(value["activities"])) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session message is invalid",
    );
  }
  const activities = value["activities"].map((activity) => {
    if (!isRecord(activity) || !Array.isArray(activity["locations"])) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity summary is invalid",
      );
    }
    const detailAvailability = activity["detailAvailability"];
    if (
      detailAvailability !== "available" &&
      detailAvailability !== "truncated" &&
      detailAvailability !== "unrecorded"
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity availability is invalid",
      );
    }
    const locations = activity["locations"];
    if (locations.some((location) => typeof location !== "string")) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity locations are invalid",
      );
    }
    const availability: SessionMessage["activities"][number]["detailAvailability"] =
      detailAvailability;
    return {
      activityId: readString(activity, "activityId"),
      activityType: readString(activity, "activityType"),
      detailAvailability: availability,
      input: readString(activity, "input", true),
      locations: locations.filter((location) => typeof location === "string"),
      name: readString(activity, "name", true),
      output: readString(activity, "output", true),
      sequence: readNumber(activity, "sequence"),
      status: readString(activity, "status"),
      title: readString(activity, "title"),
      toolKind: readString(activity, "toolKind", true),
    };
  });
  return {
    activities,
    agentId: readString(value, "agentId"),
    attempt: decodeAttempt(value["attempt"]),
    commandId: readString(value, "commandId"),
    createdAt: readString(value, "createdAt"),
    prompt: readString(value, "prompt", true),
    response: readString(value, "response", true),
    sessionId: readString(value, "sessionId"),
  };
}

function decodeMessages(value: unknown): SessionMessagePage {
  if (!isRecord(value) || !Array.isArray(value["messages"])) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The message page is invalid",
    );
  }
  const nextCursor = value["nextCursor"];
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The message cursor is invalid",
    );
  }
  return { messages: value["messages"].map(decodeMessage), nextCursor };
}

function decodeEvents(value: unknown): SessionEventPage {
  if (!isRecord(value) || !Array.isArray(value["events"])) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The event page is invalid",
    );
  }
  const hasMore = value["hasMore"];
  if (typeof hasMore !== "boolean") {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The event page is invalid",
    );
  }
  return {
    cursor: readString(value, "cursor"),
    events: value["events"].map((event) =>
      decodeCommittedSessionEvent(JSON.stringify(event)),
    ),
    hasMore,
  };
}

function decodeDetail(value: unknown): ActivityDetail {
  if (!isRecord(value)) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The activity detail is invalid",
    );
  }
  const kind = value["kind"];
  if (kind === "unrecorded") {
    return { kind };
  }
  if (kind === "deleted") {
    return { deletedAt: readString(value, "deletedAt"), kind };
  }
  if (kind === "truncated") {
    return {
      capturedBytes: readNumber(value, "capturedBytes"),
      kind,
      originalBytes: readNumber(value, "originalBytes"),
    };
  }
  if (kind === "available" && Array.isArray(value["content"])) {
    const storage = value["storage"];
    if (storage !== "archive" && storage !== "hot") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The activity storage state is invalid",
      );
    }
    return {
      artifactId: readString(value, "artifactId"),
      content: value["content"],
      input: readString(value, "input", true),
      kind,
      output: readString(value, "output", true),
      storage,
    };
  }
  throw new SessionRuntimeError(
    "session_storage_unavailable",
    "The activity detail is invalid",
  );
}

function decodeExport(value: unknown): SessionExport {
  if (
    !isRecord(value) ||
    value["formatVersion"] !== SESSION_EXPORT_FORMAT_VERSION ||
    !Array.isArray(value["activities"]) ||
    !Array.isArray(value["artifacts"]) ||
    !Array.isArray(value["commands"]) ||
    !Array.isArray(value["events"]) ||
    typeof value["bindingId"] !== "string" ||
    typeof value["directoryId"] !== "string"
  ) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The session export is invalid",
    );
  }
  const artifacts = value["artifacts"].map((artifact) => {
    if (!isRecord(artifact) || artifact["contentEncoding"] !== "identity") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The exported artifact is invalid",
      );
    }
    const contentEncoding: "identity" = "identity";
    return {
      activityId: readString(artifact, "activityId"),
      artifactId: readString(artifact, "artifactId"),
      byteLength: readNumber(artifact, "byteLength"),
      contentBase64: readString(artifact, "contentBase64", true),
      contentEncoding,
      mediaType: readString(artifact, "mediaType"),
      sha256: readString(artifact, "sha256"),
    };
  });
  return {
    activities: value["activities"].map((activity) => {
      if (!isRecord(activity)) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The exported activity is invalid",
        );
      }
      return {
        event: decodeAgentActivityEvent(JSON.stringify(activity["event"])),
        eventSequence: readNumber(activity, "eventSequence"),
      };
    }),
    artifacts,
    bindingId: value["bindingId"],
    commands: value["commands"].map((command) => {
      if (!isRecord(command) || !isRecord(command["state"])) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The exported command is invalid",
        );
      }
      const state = command["state"];
      return {
        command: decodeSessionPromptCommand(JSON.stringify(command["command"])),
        createdAt: readString(command, "createdAt"),
        response: readString(command, "response", true),
        state:
          state["kind"] === "accepted"
            ? { kind: "accepted" }
            : (decodeAttempt(state) ?? { kind: "accepted" }),
        updatedAt: readString(command, "updatedAt"),
      };
    }),
    directoryId: value["directoryId"],
    events: value["events"].map((event) =>
      decodeCommittedSessionEvent(JSON.stringify(event)),
    ),
    formatVersion: SESSION_EXPORT_FORMAT_VERSION,
    minimumSequence: readNumber(value, "minimumSequence"),
    nextSequence: readNumber(value, "nextSequence"),
    session: decodeSummary(value["session"]),
  };
}

function runtimeErrorCode(value: string): SessionRuntimeError["code"] {
  switch (value) {
    case "artifact_not_found":
    case "content_too_large":
    case "cursor_expired":
    case "invalid_cursor":
    case "invalid_export":
    case "invalid_page_size":
    case "session_access_denied":
    case "session_busy":
    case "session_conflict":
    case "session_deleted":
    case "session_not_found":
    case "session_quota_exceeded":
    case "session_storage_timeout":
    case "session_storage_unavailable":
      return value;
    default:
      return "session_storage_unavailable";
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const encoded = await response.text();
  if (encoded.length === 0 || encoded.length > MAX_INTERNAL_RESPONSE_LENGTH) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The Session Durable Object returned an invalid response",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The Session Durable Object returned invalid JSON",
      { cause },
    );
  }
  if (!response.ok) {
    if (isRecord(value) && isRecord(value["error"])) {
      const code = value["error"]["code"];
      const message = value["error"]["message"];
      if (typeof code === "string" && typeof message === "string") {
        throw new SessionRuntimeError(runtimeErrorCode(code), message);
      }
    }
    throw new SessionRuntimeError(
      "session_storage_unavailable",
      "The Session Durable Object rejected the operation",
    );
  }
  return value;
}

function encodeDirectoryCursor(
  scope: ProjectScope,
  updatedAt: number,
  sessionId: string,
): string {
  return btoa(
    JSON.stringify({
      formatVersion: 1,
      projectId: scope.projectId,
      sessionId,
      tenantId: scope.tenantId,
      updatedAt,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeDirectoryCursor(
  encoded: string,
  scope: ProjectScope,
): { readonly sessionId: string; readonly updatedAt: number } {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) {
      throw new Error("Invalid cursor alphabet");
    }
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const value: unknown = JSON.parse(atob(`${base64}${padding}`));
    if (
      !isRecord(value) ||
      value["formatVersion"] !== 1 ||
      value["tenantId"] !== scope.tenantId ||
      value["projectId"] !== scope.projectId ||
      typeof value["sessionId"] !== "string" ||
      typeof value["updatedAt"] !== "number" ||
      !Number.isSafeInteger(value["updatedAt"])
    ) {
      throw new Error("Invalid cursor fields");
    }
    return { sessionId: value["sessionId"], updatedAt: value["updatedAt"] };
  } catch (cause) {
    throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid", {
      cause,
    });
  }
}

export class CloudflareSessionRuntime implements SessionRuntime {
  readonly #database: D1Database;
  readonly #namespace: DurableObjectNamespace;
  readonly #quota: SessionQuotaPolicy;

  constructor(
    namespace: DurableObjectNamespace,
    database: D1Database,
    quota: SessionQuotaPolicy,
  ) {
    this.#database = database;
    this.#namespace = namespace;
    this.#quota = quota;
  }

  readonly createSession = async (
    scope: ProjectScope,
    request: CreateSessionRequest,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    validateCreateSessionRequest(request);
    await this.reserveSession(scope, request.sessionId, now, signal);
    const summary = decodeSummary(
      await this.request(
        scope,
        request.sessionId,
        "create",
        { now, request },
        signal,
      ),
    );
    await this.updateDirectory(summary);
    return summary;
  };

  readonly acceptCommand = async (
    scope: ProjectScope,
    runtimeId: string,
    command: SessionPromptCommand,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionCommandAcceptance> => {
    const encodedCommand = encodeSessionPromptCommand(command);
    await this.reserveSession(scope, command.sessionId, now, signal);
    const value = await this.request(
      scope,
      command.sessionId,
      "accept",
      { command: encodedCommand, now, runtimeId },
      signal,
    );
    if (
      !isRecord(value) ||
      (value["kind"] !== "accepted" && value["kind"] !== "duplicate")
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The command acceptance result is invalid",
      );
    }
    if (value["kind"] === "accepted") {
      await this.refreshDirectory(scope, command.sessionId, signal);
      return { kind: "accepted" };
    }
    const state = value["state"];
    if (
      state !== "accepted" &&
      state !== "running" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "outcome_unknown"
    ) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The duplicate command state is invalid",
      );
    }
    return { kind: "duplicate", state };
  };

  readonly commitEvent = async (
    scope: ProjectScope,
    runtimeId: string,
    envelope: SessionEventEnvelope,
    now: number,
    signal: AbortSignal,
  ): Promise<CommittedEventResult> => {
    const value = await this.request(
      scope,
      envelope.sessionId,
      "commit",
      { envelope: encodeSessionEventEnvelope(envelope), now, runtimeId },
      signal,
    );
    if (!isRecord(value) || typeof value["duplicate"] !== "boolean") {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The committed event result is invalid",
      );
    }
    const committed = decodeCommittedSessionEvent(
      JSON.stringify(value["committed"]),
    );
    await this.updateDirectory(decodeSummary(value["summary"]));
    return { committed, duplicate: value["duplicate"] };
  };

  readonly bindSession = async (
    scope: ProjectScope,
    sessionId: string,
    runtimeId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    const summary = decodeSummary(
      await this.request(
        scope,
        sessionId,
        "bind",
        { runtimeId, sessionId },
        signal,
      ),
    );
    await this.updateDirectory(summary);
    return summary;
  };

  readonly readSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    const summary = decodeSummary(
      await this.request(scope, sessionId, "read", { sessionId }, signal),
    );
    await this.updateDirectory(summary);
    return summary;
  };

  readonly listSessions = async (
    scope: ProjectScope,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionDirectoryPage> => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SessionRuntimeError(
        "invalid_page_size",
        "The page size must be between 1 and 100",
      );
    }
    const decoded =
      cursor === null ? null : decodeDirectoryCursor(cursor, scope);
    const statement =
      decoded === null
        ? this.#database
            .prepare(
              `SELECT session_id, summary_json, updated_at
             FROM session_directory
             WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'
             ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
            )
            .bind(scope.tenantId, scope.projectId, limit + 1)
        : this.#database
            .prepare(
              `SELECT session_id, summary_json, updated_at
             FROM session_directory
             WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'
               AND (updated_at < ? OR (updated_at = ? AND session_id < ?))
             ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
            )
            .bind(
              scope.tenantId,
              scope.projectId,
              decoded.updatedAt,
              decoded.updatedAt,
              decoded.sessionId,
              limit + 1,
            );
    const rows = (await statement.all<DirectoryRow>()).results;
    signal.throwIfAborted();
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeDirectoryCursor(scope, last.updated_at, last.session_id)
          : null,
      sessions: pageRows.map((row) => {
        let value: unknown;
        try {
          value = JSON.parse(row.summary_json);
        } catch (cause) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The D1 session directory is invalid",
            { cause },
          );
        }
        return decodeSummary(value);
      }),
    };
  };

  readonly readMessages = async (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionMessagePage> =>
    decodeMessages(
      await this.request(
        scope,
        sessionId,
        "messages",
        { cursor, limit, sessionId },
        signal,
      ),
    );

  readonly readEvents = async (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionEventPage> =>
    decodeEvents(
      await this.request(
        scope,
        sessionId,
        "events",
        { cursor, limit, sessionId },
        signal,
      ),
    );

  readonly readActivityDetail = async (
    scope: ProjectScope,
    sessionId: string,
    activityId: string,
    signal: AbortSignal,
  ): Promise<ActivityDetail> =>
    decodeDetail(
      await this.request(
        scope,
        sessionId,
        "detail",
        { activityId, sessionId },
        signal,
      ),
    );

  readonly exportSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionExport> =>
    decodeExport(
      await this.request(scope, sessionId, "export", { sessionId }, signal),
    );

  readonly importSession = async (
    scope: ProjectScope,
    exported: unknown,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionSummary> => {
    if (!isRecord(exported) || !isRecord(exported["session"])) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The session export is invalid",
      );
    }
    const sessionId = readString(exported["session"], "sessionId");
    if (!IDENTIFIER_PATTERN.test(sessionId)) {
      throw new SessionRuntimeError(
        "invalid_export",
        "The exported session identifier is invalid",
      );
    }
    const reservation = await this.reserveSession(
      scope,
      sessionId,
      now,
      signal,
    );
    let summary: SessionSummary;
    try {
      summary = decodeSummary(
        await this.request(
          scope,
          sessionId,
          "import",
          { exported, now },
          signal,
        ),
      );
    } catch (error) {
      if (
        reservation.kind === "reserved" &&
        error instanceof SessionRuntimeError &&
        error.code === "invalid_export"
      ) {
        await this.releaseSession(scope, sessionId, signal);
      }
      throw error;
    }
    await this.updateDirectory(summary);
    return summary;
  };

  readonly deleteSession = async (
    scope: ProjectScope,
    sessionId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionLifecycle> => {
    const previous =
      (await this.readDirectorySummary(scope, sessionId, signal)) ??
      (await this.readSession(scope, sessionId, signal));
    const value = await this.request(
      scope,
      sessionId,
      "delete",
      { now, sessionId },
      signal,
    );
    const lifecycle = decodeLifecycle(value);
    if (lifecycle.kind === "deleted") {
      await this.releaseSession(scope, sessionId, signal);
    }
    await this.updateDirectory({
      ...previous,
      lifecycle,
      updatedAt: new Date(now).toISOString(),
    });
    return lifecycle;
  };

  readonly markRuntimeDisconnected = async (
    scope: ProjectScope,
    runtimeId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<readonly ReturnType<typeof decodeCommittedSessionEvent>[]> => {
    signal.throwIfAborted();
    const rows = await this.#database
      .prepare(
        `SELECT session_id FROM session_directory
         WHERE tenant_id = ? AND project_id = ? AND runtime_id = ?
           AND lifecycle = 'active'
         LIMIT 500`,
      )
      .bind(scope.tenantId, scope.projectId, runtimeId)
      .all<{ readonly session_id: string }>();
    for (const row of rows.results) {
      await this.request(
        scope,
        row.session_id,
        "disconnect",
        { now, runtimeId },
        signal,
      );
    }
    return [];
  };

  private readonly request = async (
    scope: ProjectScope,
    sessionId: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(SESSION_OPERATION_TIMEOUT_MILLISECONDS);
    const operationSignal = AbortSignal.any([signal, timeout]);
    const id = this.#namespace.idFromName(
      `${scope.tenantId}:${scope.projectId}:${sessionId}`,
    );
    let response: Response;
    try {
      response = await this.#namespace.get(id).fetch(
        new Request(`https://session.internal/internal/sessions/${operation}`, {
          body: JSON.stringify({ ...body, scope }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: operationSignal,
        }),
      );
    } catch (cause) {
      if (signal.aborted) {
        throw cause;
      }
      throw new SessionRuntimeError(
        timeout.aborted
          ? "session_storage_timeout"
          : "session_storage_unavailable",
        timeout.aborted
          ? "The session storage operation timed out"
          : "The Session Durable Object is unavailable",
        { cause },
      );
    }
    operationSignal.throwIfAborted();
    return await responseJson(response);
  };

  private readonly reserveSession = async (
    scope: ProjectScope,
    sessionId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<SessionReservation> => {
    signal.throwIfAborted();
    try {
      const result = await this.#database
        .prepare(
          `INSERT INTO session_quota_reservations (
             tenant_id, project_id, session_id, reserved_at
           )
           SELECT ?, ?, ?, ?
           WHERE (
             SELECT COUNT(*) FROM session_quota_reservations
             WHERE tenant_id = ?
           ) < ?
             AND (
               SELECT COUNT(*) FROM session_quota_reservations
               WHERE tenant_id = ? AND project_id = ?
             ) < ?
           ON CONFLICT(tenant_id, project_id, session_id) DO NOTHING`,
        )
        .bind(
          scope.tenantId,
          scope.projectId,
          sessionId,
          now,
          scope.tenantId,
          this.#quota.activeSessionsPerTenant,
          scope.tenantId,
          scope.projectId,
          this.#quota.activeSessionsPerProject,
        )
        .run();
      signal.throwIfAborted();
      const reservation = await this.#database
        .prepare(
          `SELECT session_id FROM session_quota_reservations
           WHERE tenant_id = ? AND project_id = ? AND session_id = ?`,
        )
        .bind(scope.tenantId, scope.projectId, sessionId)
        .first<{ readonly session_id: string }>();
      signal.throwIfAborted();
      if (reservation === null) {
        throw new SessionRuntimeError(
          "session_quota_exceeded",
          "The tenant or project active session quota is exhausted",
        );
      }
      return result.meta.changes === 1
        ? { kind: "reserved" }
        : { kind: "existing" };
    } catch (cause) {
      if (signal.aborted || cause instanceof SessionRuntimeError) {
        throw cause;
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The session quota could not be reserved",
        { cause },
      );
    }
  };

  private readonly releaseSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    try {
      await this.#database
        .prepare(
          `DELETE FROM session_quota_reservations
           WHERE tenant_id = ? AND project_id = ? AND session_id = ?`,
        )
        .bind(scope.tenantId, scope.projectId, sessionId)
        .run();
      signal.throwIfAborted();
    } catch (cause) {
      if (signal.aborted) {
        throw cause;
      }
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The session quota could not be released",
        { cause },
      );
    }
  };

  private readonly readDirectorySummary = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionSummary | null> => {
    signal.throwIfAborted();
    const row = await this.#database
      .prepare(
        `SELECT summary_json FROM session_directory
         WHERE tenant_id = ? AND project_id = ? AND session_id = ?`,
      )
      .bind(scope.tenantId, scope.projectId, sessionId)
      .first<{ readonly summary_json: string }>();
    signal.throwIfAborted();
    if (row === null) {
      return null;
    }
    try {
      return decodeSummary(JSON.parse(row.summary_json));
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The D1 session directory is invalid",
        { cause },
      );
    }
  };

  private readonly refreshDirectory = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      const value = await this.request(
        scope,
        sessionId,
        "read",
        { sessionId },
        signal,
      );
      await this.updateDirectory(decodeSummary(value));
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      console.error("D1 session directory refresh failed", error);
    }
  };

  private readonly updateDirectory = async (
    summary: SessionSummary,
  ): Promise<void> => {
    try {
      await this.#database
        .prepare(
          `INSERT INTO session_directory (
             tenant_id, project_id, session_id, runtime_id, lifecycle,
             updated_at, summary_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, project_id, session_id) DO UPDATE SET
             runtime_id = excluded.runtime_id,
             lifecycle = excluded.lifecycle,
             updated_at = excluded.updated_at,
             summary_json = excluded.summary_json`,
        )
        .bind(
          summary.tenantId,
          summary.projectId,
          summary.sessionId,
          summary.runtimeId,
          summary.lifecycle.kind,
          Date.parse(summary.updatedAt),
          JSON.stringify(summary),
        )
        .run();
    } catch (cause) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The D1 session directory could not be updated",
        { cause },
      );
    }
  };
}
