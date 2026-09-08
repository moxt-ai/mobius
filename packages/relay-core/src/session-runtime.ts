import type {
  AgentActivityEvent,
  Attempt,
  CommandReceipt,
  CommittedSessionEvent,
  DomainError,
  Interaction,
  InteractionResponse,
  NativeSessionHistory,
  PendingWork,
  SessionLifecycle as ResourceSessionLifecycle,
  SessionBinding,
  SessionEventEnvelope,
  SessionPromptCommand,
  Turn,
} from "@moxt-ai/mobius-protocol";

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
  readonly idempotencyRetentionMilliseconds: number;
  readonly level: "full" | "summary";
  readonly retentionMilliseconds: number;

  constructor(
    level: "full" | "summary",
    retentionMilliseconds: number,
    hotEventLimit: number,
    contentLimitBytes: number,
    idempotencyRetentionMilliseconds = retentionMilliseconds,
  ) {
    this.contentLimitBytes = contentLimitBytes;
    this.hotEventLimit = hotEventLimit;
    this.idempotencyRetentionMilliseconds = idempotencyRetentionMilliseconds;
    this.level = level;
    this.retentionMilliseconds = retentionMilliseconds;
  }
}

export class CreateSessionBindingRequest {
  readonly agentRef: string;
  readonly bindingId: string;
  readonly configRevision: number;
  readonly runtimeId: string;
  readonly workspaceRef: string;

  constructor(
    bindingId: string,
    runtimeId: string,
    agentRef: string,
    workspaceRef: string,
    configRevision = 1,
  ) {
    this.agentRef = agentRef;
    this.bindingId = bindingId;
    this.configRevision = configRevision;
    this.runtimeId = runtimeId;
    this.workspaceRef = workspaceRef;
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
  readonly createdBy: string;

  constructor(
    sessionId: string,
    runtimeId: string,
    agentId: string,
    bindingId: string,
    directoryId: string,
    policy: SessionRecordingPolicy,
    title = "",
    createdBy = "project-client",
  ) {
    this.agentId = agentId;
    this.bindingId = bindingId;
    this.directoryId = directoryId;
    this.policy = policy;
    this.runtimeId = runtimeId;
    this.sessionId = sessionId;
    this.title = title;
    this.createdBy = createdBy;
  }

  get binding(): CreateSessionBindingRequest {
    return new CreateSessionBindingRequest(
      this.bindingId,
      this.runtimeId,
      this.agentId,
      this.directoryId,
    );
  }
}

export type SessionLifecycle = ResourceSessionLifecycle;

export interface SessionSummary {
  readonly agentId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly defaultBinding: SessionBinding;
  readonly hasNativeHistory: boolean;
  readonly lastCommittedSeq: string;
  readonly lifecycle: SessionLifecycle;
  readonly policy: {
    readonly contentLimitBytes: number;
    readonly hotEventLimit: number;
    readonly idempotencyRetentionMilliseconds: number;
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
      readonly attemptId: string;
      readonly dispatchedAt: string;
      readonly kind: "dispatching";
    }
  | {
      readonly attemptId: string;
      readonly kind: "running";
      readonly startedAt: string;
    }
  | {
      readonly attemptId: string;
      readonly completedAt: string;
      readonly kind: "succeeded";
      readonly startedAt: string;
      readonly stopReason: string;
    }
  | {
      readonly attemptId: string;
      readonly cancelledAt: string;
      readonly kind: "cancelled";
      readonly startedAt: string;
    }
  | {
      readonly attemptId: string;
      readonly interactionIds: readonly string[];
      readonly kind: "waiting_input";
      readonly startedAt: string;
    }
  | {
      readonly code: string;
      readonly failedAt: string;
      readonly kind: "failed";
      readonly message: string;
      readonly attemptId: string | null;
      readonly startedAt: string | null;
    }
  | {
      readonly attemptId: string;
      readonly detectedAt: string;
      readonly kind: "indeterminate";
      readonly startedAt: string;
    };

export interface SessionMessage {
  readonly activities: readonly {
    readonly activityId: string;
    readonly attemptId: string;
    readonly activityType: string;
    readonly detailAvailability: "available" | "truncated" | "unrecorded";
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolCallId: string;
    readonly toolKind: string;
  }[];
  readonly additionalDirectoryIds: readonly string[];
  readonly agentId: string;
  readonly attempt: AttemptSummary | null;
  readonly commandId: string;
  readonly createdAt: string;
  readonly images: SessionPromptCommand["images"];
  readonly prompt: string;
  readonly resources: SessionPromptCommand["resources"];
  readonly response: string;
  readonly sessionId: string;
}

export interface SessionMessagePage {
  readonly lastCommittedSeq: string;
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

export interface AcceptedTurn {
  readonly kind: "accepted";
  readonly pendingWork: PendingWork;
  readonly turn: Turn;
}

export interface DuplicateTurn {
  readonly kind: "duplicate";
  readonly pendingWork: PendingWork | null;
  readonly state: Turn["state"]["kind"];
  readonly turn: Turn;
}

export type TurnAcceptance = AcceptedTurn | DuplicateTurn;

export type AttemptReconciliationOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "succeeded"; readonly stopReason: string }
  | { readonly error: DomainError; readonly kind: "failed" }
  | { readonly kind: "cancelled" };

export interface CommittedEventResult {
  readonly committed: CommittedSessionEvent;
  readonly duplicate: boolean;
}

export interface InteractionResponseAcceptance {
  readonly duplicate: boolean;
  readonly interaction: Interaction;
  readonly pendingWork: PendingWork;
}

export interface PendingDaemonDelivery {
  readonly interactionId: string | null;
  readonly payload: string;
  readonly pendingWork: PendingWork;
}

export interface SessionExport {
  readonly bindings: readonly SessionBinding[];
  readonly commandReceipts: readonly CommandReceipt[];
  readonly toolCallViews: readonly {
    readonly attemptId: string;
    readonly event: AgentActivityEvent;
    readonly eventSequence: string;
  }[];
  readonly artifacts: readonly {
    readonly attemptId: string;
    readonly artifactId: string;
    readonly byteLength: number;
    readonly contentBase64: string;
    readonly contentEncoding: "identity";
    readonly mediaType: string;
    readonly sha256: string;
    readonly toolCallId: string;
  }[];
  readonly turns: readonly {
    readonly command: SessionPromptCommand;
    readonly createdAt: string;
    readonly response: string;
    readonly state: AttemptSummary | { readonly kind: "queued" };
    readonly turn: Turn;
    readonly updatedAt: string;
  }[];
  readonly events: readonly CommittedSessionEvent[];
  readonly interactions: readonly Interaction[];
  readonly minimumSequence: string;
  readonly nativeHistory: NativeSessionHistory | null;
  readonly nextSequence: string;
  readonly session: SessionSummary;
}

export class SessionRuntimeError extends Error {
  readonly code:
    | "artifact_not_found"
    | "content_too_large"
    | "cursor_expired"
    | "event_source_conflict"
    | "invalid_cursor"
    | "invalid_export"
    | "invalid_page_size"
    | "idempotency_conflict"
    | "interaction_conflict"
    | "interaction_not_found"
    | "pending_work_not_found"
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

export interface SessionCommandPort {
  readonly acceptInteractionResponse: (
    scope: ProjectScope,
    sessionId: string,
    interactionId: string,
    responderId: string,
    response: InteractionResponse,
    deliveryPayload: string,
    now: number,
    signal: AbortSignal,
  ) => Promise<InteractionResponseAcceptance>;
  readonly acceptTurn: (
    scope: ProjectScope,
    runtimeId: string,
    command: SessionPromptCommand,
    now: number,
    signal: AbortSignal,
  ) => Promise<TurnAcceptance>;
  readonly setDefaultBinding: (
    scope: ProjectScope,
    sessionId: string,
    binding: CreateSessionBindingRequest,
    now: number,
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
  readonly listPendingDaemonDeliveries: (
    scope: ProjectScope,
    runtimeId: string,
    limit: number,
    signal: AbortSignal,
  ) => Promise<readonly PendingDaemonDelivery[]>;
  readonly markPendingWorkCompleted: (
    scope: ProjectScope,
    sessionId: string,
    workId: string,
    now: number,
    signal: AbortSignal,
  ) => Promise<PendingWork>;
  readonly markRuntimeDisconnected: (
    scope: ProjectScope,
    runtimeId: string,
    now: number,
    signal: AbortSignal,
  ) => Promise<readonly CommittedSessionEvent[]>;
  readonly recordNativeHistory: (
    scope: ProjectScope,
    runtimeId: string,
    sessionId: string,
    title: string,
    history: NativeSessionHistory,
    now: number,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly reconcileAttempt: (
    scope: ProjectScope,
    runtimeId: string,
    sessionId: string,
    attemptId: string,
    outcome: AttemptReconciliationOutcome,
    now: number,
    signal: AbortSignal,
  ) => Promise<Attempt>;
}

export interface SessionQueryPort {
  readonly listSessions: (
    scope: ProjectScope,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<SessionDirectoryPage>;
  readonly readAttempt: (
    scope: ProjectScope,
    sessionId: string,
    attemptId: string,
    signal: AbortSignal,
  ) => Promise<Attempt>;
  readonly readInteraction: (
    scope: ProjectScope,
    sessionId: string,
    interactionId: string,
    signal: AbortSignal,
  ) => Promise<Interaction>;
  readonly readPendingInteractions: (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<readonly Interaction[]>;
  readonly readSession: (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SessionSummary>;
  readonly readTurn: (
    scope: ProjectScope,
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
  ) => Promise<Turn>;
  readonly readToolCallDetail: (
    scope: ProjectScope,
    sessionId: string,
    attemptId: string,
    toolCallId: string,
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
  readonly readNativeHistory: (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<NativeSessionHistory | null>;
}

export interface SessionTransferPort {
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
}

export interface SessionRuntime
  extends SessionCommandPort,
    SessionQueryPort,
    SessionTransferPort {}
