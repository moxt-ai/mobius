import type {
    AgentActivityEvent,
    AgentDisplayContent,
    CommandReceipt,
    CommittedSessionEvent,
    DomainError,
    Interaction,
    NativeSessionHistory,
    PendingWork,
    SessionLifecycle as ResourceSessionLifecycle,
    SessionBinding,
    SessionConfigOption,
    SessionOperationFailedEvent,
    SessionPromptCommand,
    Turn,
} from "@moxt-ai/mobius-protocol";
import type { HttpError } from "../http-error.ts";

export class SessionQuotaPolicy {
    readonly activeSessionsPerProject: number;

    constructor(activeSessionsPerProject: number) {
        if (!Number.isSafeInteger(activeSessionsPerProject) || activeSessionsPerProject < 1) {
            throw new TypeError("The session quota policy is invalid");
        }
        this.activeSessionsPerProject = activeSessionsPerProject;
    }
}

export const DEFAULT_SESSION_QUOTA_POLICY = new SessionQuotaPolicy(1_000);

export const SESSION_DIRECTORY_IDENTIFIER_MAX_LENGTH = 2_048;
const SESSION_DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;

export function isSessionDirectoryIdentifier(value: unknown): boolean {
    return typeof value === "string" && SESSION_DIRECTORY_IDENTIFIER_PATTERN.test(value);
}

export class ProjectScope {
    readonly projectId: string;

    constructor(projectId: string) {
        this.projectId = projectId;
    }
}

export interface SessionQuotaPolicyProvider {
    readonly resolveSessionQuota: (scope: ProjectScope, signal: AbortSignal) => Promise<SessionQuotaPolicy>;
    readonly recordSessionQuotaDenial: (
        scope: ProjectScope,
        sessionId: string,
        policy: SessionQuotaPolicy,
        signal: AbortSignal,
    ) => Promise<void>;
}

export class StaticSessionQuotaPolicyProvider implements SessionQuotaPolicyProvider {
    readonly #policy: SessionQuotaPolicy;

    constructor(policy: SessionQuotaPolicy) {
        this.#policy = policy;
    }

    readonly resolveSessionQuota = async (_scope: ProjectScope, signal: AbortSignal): Promise<SessionQuotaPolicy> => {
        signal.throwIfAborted();
        return this.#policy;
    };

    readonly recordSessionQuotaDenial = async (
        _scope: ProjectScope,
        _sessionId: string,
        _policy: SessionQuotaPolicy,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
    };
}

export const ARTIFACT_UPLOAD_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

export class CreateArtifactUploadRequest {
    readonly byteLength: number;
    readonly mediaType: string;
    readonly name: string;
    readonly sha256: string;

    constructor(name: string, mediaType: string, byteLength: number, sha256: string) {
        this.byteLength = byteLength;
        this.mediaType = mediaType;
        this.name = name;
        this.sha256 = sha256;
    }
}

export abstract class ArtifactDescriptor {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly createdAt: string;
    readonly mediaType: string;
    readonly name: string;
    readonly sessionId: string;
    readonly sha256: string;
    abstract readonly state: string;

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
    ) {
        this.artifactId = artifactId;
        this.byteLength = byteLength;
        this.createdAt = createdAt;
        this.mediaType = mediaType;
        this.name = name;
        this.sessionId = sessionId;
        this.sha256 = sha256;
    }
}

export class UploadingArtifactDescriptor extends ArtifactDescriptor {
    readonly expiresAt: string;
    readonly state = "uploading";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        expiresAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.expiresAt = expiresAt;
    }
}

export class ArtifactUploadAuthorization extends UploadingArtifactDescriptor {
    readonly uploadToken: string;

    constructor(descriptor: UploadingArtifactDescriptor, uploadToken: string) {
        super(
            descriptor.sessionId,
            descriptor.artifactId,
            descriptor.name,
            descriptor.mediaType,
            descriptor.byteLength,
            descriptor.sha256,
            descriptor.createdAt,
            descriptor.expiresAt,
        );
        this.uploadToken = uploadToken;
    }
}

export class AvailableArtifactDescriptor extends ArtifactDescriptor {
    readonly availableAt: string;
    readonly state = "available";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        availableAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.availableAt = availableAt;
    }
}

export class ExpiredArtifactDescriptor extends ArtifactDescriptor {
    readonly expiredAt: string;
    readonly state = "expired";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        expiredAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.expiredAt = expiredAt;
    }
}

export class ArtifactUploadLease {
    readonly artifact: UploadingArtifactDescriptor;
    readonly contentTargetId: string;

    constructor(artifact: UploadingArtifactDescriptor, contentTargetId: string) {
        this.artifact = artifact;
        this.contentTargetId = contentTargetId;
    }
}

export class ArtifactContent {
    readonly artifact: AvailableArtifactDescriptor;
    readonly bytes: Uint8Array;

    constructor(artifact: AvailableArtifactDescriptor, bytes: Uint8Array) {
        this.artifact = artifact;
        this.bytes = bytes;
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

    constructor(bindingId: string, runtimeId: string, agentRef: string, workspaceRef: string, configRevision = 1) {
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
        return new CreateSessionBindingRequest(this.bindingId, this.runtimeId, this.agentId, this.directoryId);
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

export interface SessionMessageContent {
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
    readonly attempt: AttemptSummary | null;
    readonly createdAt: string;
    readonly disposition: string;
    readonly images: SessionPromptCommand["images"];
    readonly messageId: string;
    readonly prompt: string;
    readonly resources: SessionPromptCommand["resources"];
    readonly response: string;
}

export interface SessionMessage extends SessionMessageContent {
    readonly agentId: string;
    readonly commandId: string;
    readonly contents: readonly AgentDisplayContent[];
    readonly sessionId: string;
    readonly targetCommandId: string;
}

export interface SessionMessagePage {
    readonly lastCommittedSeq: string;
    readonly messages: readonly SessionMessage[];
    readonly nextCursor: string | null;
    readonly tailEventCursor: string;
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

export interface TurnCancellationAcceptance {
    readonly duplicate: boolean;
    readonly pendingWork: PendingWork;
    readonly turn: Turn;
}

export class SessionConfigurationSnapshot {
    readonly options: readonly SessionConfigOption[];
    readonly revision: number;
    readonly updatedAt: string;

    constructor(options: readonly SessionConfigOption[], revision: number, updatedAt: string) {
        this.options = Object.freeze([...options]);
        this.revision = revision;
        this.updatedAt = updatedAt;
    }
}

export class SessionConfigurationAcceptance {
    readonly duplicate: boolean;
    readonly pendingWork: PendingWork;
    readonly requestId: string;
    readonly status = "accepted";

    constructor(requestId: string, duplicate: boolean, pendingWork: PendingWork) {
        this.duplicate = duplicate;
        this.pendingWork = pendingWork;
        this.requestId = requestId;
    }
}

export interface SessionUploadedArtifactExport {
    readonly artifactId: string;
    readonly availableAt: string;
    readonly byteLength: number;
    readonly contentBase64: string;
    readonly contentEncoding: "identity";
    readonly createdAt: string;
    readonly mediaType: string;
    readonly name: string;
    readonly sha256: string;
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
    readonly uploadedArtifacts: readonly SessionUploadedArtifactExport[];
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

function sessionRuntimeErrorStatus(code: string): number {
    if (code === "execution_capability_invalid") {
        return 401;
    }
    if (
        code === "conversation_access_denied" ||
        code === "delivery_target_not_allowed" ||
        code === "execution_context_mismatch"
    ) {
        return 403;
    }
    if (code === "execution_capability_expired") {
        return 410;
    }
    if (code === "queue_full") {
        return 429;
    }
    if (
        code === "session_not_found" ||
        code === "artifact_not_found" ||
        code === "interaction_not_found" ||
        code === "pending_work_not_found"
    ) {
        return 404;
    }
    if (code === "session_access_denied" || code === "artifact_upload_unauthorized") {
        return 403;
    }
    if (code === "session_deleted" || code === "cursor_expired" || code === "artifact_upload_expired") {
        return 410;
    }
    if (code === "session_quota_exceeded") {
        return 429;
    }
    if (
        code === "session_busy" ||
        code === "session_conflict" ||
        code === "idempotency_conflict" ||
        code === "interaction_conflict" ||
        code === "event_source_conflict" ||
        code === "artifact_upload_closed" ||
        code === "artifact_not_ready"
    ) {
        return 409;
    }
    if (code === "content_too_large") {
        return 413;
    }
    if (
        code === "invalid_cursor" ||
        code === "invalid_export" ||
        code === "invalid_page_size" ||
        code === "invalid_request" ||
        code === "artifact_content_mismatch"
    ) {
        return 400;
    }
    return 503;
}

interface SessionRuntimeErrorOptions extends ErrorOptions {
    readonly runtimeTimings?: NonNullable<SessionOperationFailedEvent["runtimeTimings"]> | undefined;
}

export class SessionRuntimeError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;
    readonly runtimeTimings: NonNullable<SessionOperationFailedEvent["runtimeTimings"]>;

    constructor(code: string, message: string, options: SessionRuntimeErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = sessionRuntimeErrorStatus(code);
        this.name = "SessionRuntimeError";
        this.runtimeTimings = options.runtimeTimings ?? [];
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}
