import type {
  AgentActivityEvent,
  CommittedSessionEvent,
  SessionEventEnvelope,
  SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";

export const SESSION_EXPORT_FORMAT_VERSION = 2;

export class SessionQuotaPolicy {
  readonly activeSessionsPerProject: number;
  readonly activeSessionsPerTenant: number;

  constructor(
    activeSessionsPerTenant: number,
    activeSessionsPerProject: number,
  ) {
    if (
      !Number.isSafeInteger(activeSessionsPerTenant) ||
      activeSessionsPerTenant < 1 ||
      !Number.isSafeInteger(activeSessionsPerProject) ||
      activeSessionsPerProject < 1 ||
      activeSessionsPerProject > activeSessionsPerTenant
    ) {
      throw new TypeError("The session quota policy is invalid");
    }
    this.activeSessionsPerProject = activeSessionsPerProject;
    this.activeSessionsPerTenant = activeSessionsPerTenant;
  }
}

export const DEFAULT_SESSION_QUOTA_POLICY = new SessionQuotaPolicy(
  10_000,
  1_000,
);

export class ProjectScope {
  readonly projectId: string;
  readonly tenantId: string;

  constructor(tenantId: string, projectId: string) {
    this.projectId = projectId;
    this.tenantId = tenantId;
  }
}

export class SessionRecordingPolicy {
  readonly contentLimitBytes: number;
  readonly hotEventLimit: number;
  readonly level: "full" | "summary";
  readonly retentionMilliseconds: number;

  constructor(
    level: "full" | "summary",
    retentionMilliseconds: number,
    hotEventLimit: number,
    contentLimitBytes: number,
  ) {
    this.contentLimitBytes = contentLimitBytes;
    this.hotEventLimit = hotEventLimit;
    this.level = level;
    this.retentionMilliseconds = retentionMilliseconds;
  }
}

export class CreateSessionRequest {
  readonly agentId: string;
  readonly bindingId: string;
  readonly directoryId: string;
  readonly policy: SessionRecordingPolicy;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly title: string;

  constructor(
    sessionId: string,
    runtimeId: string,
    agentId: string,
    bindingId: string,
    directoryId: string,
    policy: SessionRecordingPolicy,
    title = "",
  ) {
    this.agentId = agentId;
    this.bindingId = bindingId;
    this.directoryId = directoryId;
    this.policy = policy;
    this.runtimeId = runtimeId;
    this.sessionId = sessionId;
    this.title = title;
  }
}

export type SessionLifecycle =
  | { readonly kind: "active" }
  | { readonly kind: "deleting"; readonly requestedAt: string }
  | { readonly completedAt: string; readonly kind: "deleted" };

export interface SessionSummary {
  readonly agentId: string;
  readonly createdAt: string;
  readonly lifecycle: SessionLifecycle;
  readonly policy: {
    readonly contentLimitBytes: number;
    readonly hotEventLimit: number;
    readonly level: "full" | "summary";
    readonly retentionMilliseconds: number;
  };
  readonly projectId: string;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly tenantId: string;
  readonly updatedAt: string;
}

export interface SessionDirectoryPage {
  readonly nextCursor: string | null;
  readonly sessions: readonly SessionSummary[];
}

export type AttemptSummary =
  | {
      readonly kind: "running";
      readonly processAttemptId: string;
      readonly startedAt: string;
    }
  | {
      readonly completedAt: string;
      readonly kind: "completed";
      readonly processAttemptId: string;
      readonly startedAt: string;
      readonly stopReason: string;
    }
  | {
      readonly code: string;
      readonly failedAt: string;
      readonly kind: "failed";
      readonly message: string;
      readonly processAttemptId: string | null;
      readonly startedAt: string | null;
    }
  | {
      readonly disconnectedAt: string;
      readonly kind: "outcome_unknown";
      readonly processAttemptId: string;
      readonly startedAt: string;
    };

export interface SessionMessage {
  readonly activities: readonly {
    readonly activityId: string;
    readonly activityType: string;
    readonly detailAvailability: "available" | "truncated" | "unrecorded";
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;
  }[];
  readonly agentId: string;
  readonly attempt: AttemptSummary | null;
  readonly commandId: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly response: string;
  readonly sessionId: string;
}

export interface SessionMessagePage {
  readonly messages: readonly SessionMessage[];
  readonly nextCursor: string | null;
}

export interface SessionEventPage {
  readonly cursor: string;
  readonly events: readonly CommittedSessionEvent[];
  readonly hasMore: boolean;
}

export type ActivityDetail =
  | {
      readonly artifactId: string;
      readonly content: readonly unknown[];
      readonly input: string;
      readonly kind: "available";
      readonly output: string;
      readonly storage: "archive" | "hot";
    }
  | {
      readonly capturedBytes: number;
      readonly kind: "truncated";
      readonly originalBytes: number;
    }
  | { readonly kind: "unrecorded" }
  | { readonly deletedAt: string; readonly kind: "deleted" };

export interface AcceptedSessionCommand {
  readonly kind: "accepted";
}

export interface DuplicateSessionCommand {
  readonly kind: "duplicate";
  readonly state:
    | "accepted"
    | "completed"
    | "failed"
    | "outcome_unknown"
    | "running";
}

export type SessionCommandAcceptance =
  | AcceptedSessionCommand
  | DuplicateSessionCommand;

export interface CommittedEventResult {
  readonly committed: CommittedSessionEvent;
  readonly duplicate: boolean;
}

export interface SessionExport {
  readonly activities: readonly {
    readonly event: AgentActivityEvent;
    readonly eventSequence: number;
  }[];
  readonly artifacts: readonly {
    readonly activityId: string;
    readonly artifactId: string;
    readonly byteLength: number;
    readonly contentBase64: string;
    readonly contentEncoding: "identity";
    readonly mediaType: string;
    readonly sha256: string;
  }[];
  readonly bindingId: string;
  readonly commands: readonly {
    readonly command: SessionPromptCommand;
    readonly createdAt: string;
    readonly response: string;
    readonly state: AttemptSummary | { readonly kind: "accepted" };
    readonly updatedAt: string;
  }[];
  readonly directoryId: string;
  readonly events: readonly CommittedSessionEvent[];
  readonly formatVersion: typeof SESSION_EXPORT_FORMAT_VERSION;
  readonly minimumSequence: number;
  readonly nextSequence: number;
  readonly session: SessionSummary;
}

export class SessionRuntimeError extends Error {
  readonly code:
    | "artifact_not_found"
    | "content_too_large"
    | "cursor_expired"
    | "invalid_cursor"
    | "invalid_export"
    | "invalid_page_size"
    | "session_access_denied"
    | "session_busy"
    | "session_conflict"
    | "session_deleted"
    | "session_not_found"
    | "session_quota_exceeded"
    | "session_storage_timeout"
    | "session_storage_unavailable";

  constructor(
    code: SessionRuntimeError["code"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.code = code;
    this.name = "SessionRuntimeError";
  }
}

export interface SessionRuntime {
  readonly acceptCommand: (
    scope: ProjectScope,
    runtimeId: string,
    command: SessionPromptCommand,
    now: number,
    signal: AbortSignal,
  ) => Promise<SessionCommandAcceptance>;
  readonly bindSession: (
    scope: ProjectScope,
    sessionId: string,
    runtimeId: string,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly commitEvent: (
    scope: ProjectScope,
    runtimeId: string,
    envelope: SessionEventEnvelope,
    now: number,
    signal: AbortSignal,
  ) => Promise<CommittedEventResult>;
  readonly createSession: (
    scope: ProjectScope,
    request: CreateSessionRequest,
    now: number,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly deleteSession: (
    scope: ProjectScope,
    sessionId: string,
    now: number,
    signal: AbortSignal,
  ) => Promise<SessionLifecycle>;
  readonly exportSession: (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SessionExport>;
  readonly importSession: (
    scope: ProjectScope,
    exported: unknown,
    now: number,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly listSessions: (
    scope: ProjectScope,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<SessionDirectoryPage>;
  readonly readSession: (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly markRuntimeDisconnected: (
    scope: ProjectScope,
    runtimeId: string,
    now: number,
    signal: AbortSignal,
  ) => Promise<readonly CommittedSessionEvent[]>;
  readonly readActivityDetail: (
    scope: ProjectScope,
    sessionId: string,
    activityId: string,
    signal: AbortSignal,
  ) => Promise<ActivityDetail>;
  readonly readEvents: (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<SessionEventPage>;
  readonly readMessages: (
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<SessionMessagePage>;
}
