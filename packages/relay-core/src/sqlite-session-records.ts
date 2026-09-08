import {
    AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT,
    AGENT_ACTIVITY_RECORDED_FIELD_LIMIT,
    type AgentActivityEvent,
    type Attempt,
    type CommittedSessionEvent,
    decodeCommittedSessionEvent,
    decodeInteractionRequest,
    decodeInteractionResponse,
    decodeRecordedAgentContentValue,
    decodeSessionBinding,
    decodeSessionPromptCommand,
    encodeCommittedSessionEvent,
    type Interaction,
    type PendingWork,
    type RecordedSessionEvent,
    SESSION_EVENT_COMMITTED_KIND,
    type SessionBinding,
    type SessionEventEnvelope,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";

import {
    type AttemptSummary,
    type CreateSessionRequest,
    type ProjectScope,
    type SessionLifecycle,
    SessionRuntimeError,
    type SessionSummary,
} from "./session-runtime.ts";

export const MAX_ARCHIVE_BATCH_SIZE = 32;
export const MAX_EXPORT_BYTE_LENGTH = 64 * 1024 * 1024;
export const MIN_PENDING_ARCHIVE_BYTE_LIMIT = 8 * 1024 * 1024;
export const MAX_PENDING_ARCHIVE_BYTE_LIMIT = 128 * 1024 * 1024;
export const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_HOT_EVENT_LIMIT = 1_000;
export const DEFAULT_CONTENT_LIMIT_BYTES = 6_000_000;
export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;

import { encodeCursor } from "./session-cursors.ts";
import type { SessionSqlRow } from "./session-sql-database.ts";

export interface PreparedEvent {
    readonly activityDetail: {
        readonly activityId: string;
        readonly artifactId: string;
        readonly payload: string;
    } | null;
    readonly event: RecordedSessionEvent;
    readonly payload: string;
}

export interface ImportedCommand {
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
    readonly state: "cancelled" | "failed" | "indeterminate" | "queued" | "running" | "succeeded";
    readonly stopReason: string | null;
    readonly turnId: string;
    readonly updatedAt: number;
}

export interface ImportedActivity {
    readonly attemptId: string;
    readonly event: AgentActivityEvent;
    readonly eventSequence: number;
}

export function scopeKey(scope: ProjectScope): string {
    validateDomainIdentifier(scope.tenantId, "tenant");
    validateDomainIdentifier(scope.projectId, "project");
    return `${scope.tenantId}:${scope.projectId}`;
}

export function validateDomainIdentifier(value: string, field: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new SessionRuntimeError("session_access_denied", `The ${field} identifier is invalid`);
    }
    return value;
}

export function validateCreateSessionRequest(request: CreateSessionRequest): void {
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
        request.policy.idempotencyRetentionMilliseconds > request.policy.retentionMilliseconds ||
        !Number.isSafeInteger(request.policy.idempotencyRetentionMilliseconds) ||
        (request.policy.level !== "full" && request.policy.level !== "summary") ||
        !Number.isSafeInteger(request.binding.configRevision) ||
        request.binding.configRevision < 0
    ) {
        throw new SessionRuntimeError("session_conflict", "The session recording policy is invalid");
    }
}

export function validateTimestamp(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new SessionRuntimeError("session_conflict", "The session operation timestamp is invalid");
    }
    return value;
}

import { hasExactKeys, isRecord } from "./session-codec.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";

export function decodeActivityDetailPayload(
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
            content: value["content"].map((entry) => decodeRecordedAgentContentValue(entry)),
            input: value["input"],
            output: value["output"],
        };
    } catch (cause) {
        throw new SessionRuntimeError(code, message, { cause });
    }
}

export function validateLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new SessionRuntimeError("invalid_page_size", "The page size must be between 1 and 100");
    }
}

export function lifecycleFromRow(row: SessionSqlRow): SessionLifecycle {
    const lifecycle = rowString(row, "lifecycle");
    if (lifecycle === "ready") {
        return { kind: "ready" };
    }
    if (lifecycle === "deleting") {
        return {
            kind: "deleting",
            requestedAt: new Date(rowNumber(row, "delete_requested_at")).toISOString(),
        };
    }
    if (lifecycle === "deleted") {
        return {
            completedAt: new Date(rowNumber(row, "delete_completed_at")).toISOString(),
            kind: "deleted",
        };
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The session lifecycle is invalid");
}

export function summaryFromRow(row: SessionSqlRow): SessionSummary {
    const recordingLevel = rowString(row, "recording_level");
    if (recordingLevel !== "full" && recordingLevel !== "summary") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session recording level is invalid");
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
            idempotencyRetentionMilliseconds: rowNumber(row, "idempotency_retention_milliseconds"),
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

export function bindingFromRow(row: SessionSqlRow): SessionBinding {
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

export function eventCursor(scope: ProjectScope, sessionId: string, sequence: number): string {
    return encodeCursor({
        projectId: scope.projectId,
        sequence,
        sessionId,
        tenantId: scope.tenantId,
    });
}

export function committedFromRow(
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

function eventSourceFromRow(row: SessionSqlRow): SessionEventEnvelope["source"] {
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
    throw new SessionRuntimeError("session_storage_unavailable", "The event source identity is invalid");
}

export function turnFromRow(row: SessionSqlRow): Turn {
    let command: SessionPromptCommand;
    try {
        command = decodeSessionPromptCommand(rowString(row, "command_json"));
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn request is invalid", { cause });
    }
    const state = rowString(row, "state");
    const updatedAt = new Date(rowNumber(row, "updated_at")).toISOString();
    let turnState: Turn["state"];
    if (state === "queued") {
        turnState = { kind: "queued" };
    } else if (state === "running") {
        const startedAt = Reflect.get(row, "started_at");
        if (typeof startedAt !== "number") {
            throw new SessionRuntimeError("session_storage_unavailable", "The running Turn is incomplete");
        }
        turnState = {
            kind: "running",
            startedAt: new Date(startedAt).toISOString(),
        };
    } else if (state === "succeeded") {
        const stopReason = rowNullableString(row, "stop_reason") ?? "unknown";
        const completedAt = Reflect.get(row, "completed_at");
        if (typeof completedAt !== "number") {
            throw new SessionRuntimeError("session_storage_unavailable", "The completed Turn is incomplete");
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
                message: rowNullableString(row, "error_message") ?? "The execution failed",
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
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn state is invalid");
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

export function attemptFromResourceRow(row: SessionSqlRow): Attempt {
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
            throw new SessionRuntimeError("session_storage_unavailable", "The completed Attempt is incomplete");
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
                message: rowNullableString(row, "error_message") ?? "The execution failed",
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
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Attempt state is invalid");
    }
    return {
        attemptId: rowString(row, "attempt_id"),
        bindingId: rowString(row, "binding_id"),
        sessionId: rowString(row, "session_id"),
        state: attemptState,
        turnId: rowString(row, "turn_id"),
    };
}

export function interactionFromRow(row: SessionSqlRow): Interaction {
    let request: Interaction["request"];
    try {
        request = decodeInteractionRequest(JSON.parse(rowString(row, "request_json")));
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Interaction request is invalid", {
            cause,
        });
    }
    const state = rowString(row, "state");
    let interactionState: Interaction["state"];
    if (state === "pending") {
        interactionState = { kind: "pending" };
    } else if (state === "responded") {
        const responseJson = rowNullableString(row, "response_json");
        const responderId = rowNullableString(row, "responder_id");
        const respondedAt = Reflect.get(row, "responded_at");
        if (responseJson === null || responderId === null || typeof respondedAt !== "number") {
            throw new SessionRuntimeError("session_storage_unavailable", "The responded Interaction is incomplete");
        }
        let responseValue: unknown;
        try {
            responseValue = JSON.parse(responseJson);
        } catch (cause) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Interaction response is invalid", {
                cause,
            });
        }
        if (
            !isRecord(responseValue) ||
            (responseValue["kind"] !== "permission" && responseValue["kind"] !== "elicitation") ||
            typeof responseValue["content"] !== "string"
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Interaction response is invalid");
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
        let resolution: Extract<Interaction["state"], { readonly kind: "resolved" }>["resolution"];
        if (responseJson === null && responderId === null && (respondedAt === null || respondedAt === undefined)) {
            resolution = { kind: "without_response" };
        } else if (responseJson !== null && responderId !== null && typeof respondedAt === "number") {
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
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Interaction state is invalid");
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

export function identifierArrayFromJson(encoded: string, field: string): string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", `The stored ${field} list is invalid`, { cause });
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !IDENTIFIER_PATTERN.test(entry))) {
        throw new SessionRuntimeError("session_storage_unavailable", `The stored ${field} list is invalid`);
    }
    return value;
}

export function pendingWorkFromRow(row: SessionSqlRow, scope: ProjectScope): PendingWork {
    const kind = rowString(row, "work_kind");
    if (
        kind !== "archive" &&
        kind !== "delete" &&
        kind !== "dispatch" &&
        kind !== "interaction_response" &&
        kind !== "projection"
    ) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored PendingWork kind is invalid");
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
                      nextAttemptAt: new Date(rowNumber(row, "next_attempt_at")).toISOString(),
                  }
                : {
                      error,
                      failedAt: new Date(rowNumber(row, "completed_at")).toISOString(),
                      kind: "failed",
                  };
    } else {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored PendingWork state is invalid");
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

export function attemptSummaryFromRow(row: SessionSqlRow): AttemptSummary | null {
    const state = rowString(row, "state");
    if (state === "queued") {
        return null;
    }
    const attemptId = rowNullableString(row, "attempt_id");
    const startedAtValue = Reflect.get(row, "started_at");
    const startedAt = typeof startedAtValue === "number" ? new Date(startedAtValue).toISOString() : null;
    if (state === "failed") {
        const failedAt = Reflect.get(row, "completed_at");
        return {
            code: rowNullableString(row, "error_code") ?? "session_failed",
            failedAt: new Date(typeof failedAt === "number" ? failedAt : rowNumber(row, "updated_at")).toISOString(),
            kind: "failed",
            message: rowNullableString(row, "error_message") ?? "The session failed",
            attemptId,
            startedAt,
        };
    }
    if (attemptId === null || startedAt === null) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored attempt is incomplete");
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
            throw new SessionRuntimeError("session_storage_unavailable", "The stored completion is incomplete");
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
    throw new SessionRuntimeError("session_storage_unavailable", "The stored command state is invalid");
}
