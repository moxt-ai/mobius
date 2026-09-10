import * as v from "valibot";

const UploadedArtifactRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    artifact_id: v.string(),
    file_name: v.string(),
    media_type: v.string(),
    state: v.picklist(["uploading", "available", "expired"]),
    byte_length: v.pipe(v.number(), v.safeInteger()),
    sha256: v.string(),
    content_target_id: v.string(),
    upload_token_hash: v.string(),
    upload_expires_at: v.pipe(v.number(), v.safeInteger()),
    created_at: v.pipe(v.number(), v.safeInteger()),
    available_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
});

export const UploadedArtifactRowSchema = v.object({
    ...v.omit(UploadedArtifactRecordSchema, ["scope_key", "available_at"]).entries,
    available_at: v.nullable(v.string()),
});
export type UploadedArtifactRow = Readonly<v.InferOutput<typeof UploadedArtifactRowSchema>>;

export const UploadedArtifactIdentitySchema = v.pick(UploadedArtifactRecordSchema, ["artifact_id"]);
export type UploadedArtifactIdentity = Readonly<v.InferOutput<typeof UploadedArtifactIdentitySchema>>;

export const UploadedContentTargetSchema = v.pick(UploadedArtifactRecordSchema, ["content_target_id"]);
export type UploadedContentTarget = Readonly<v.InferOutput<typeof UploadedContentTargetSchema>>;

export const ArtifactCountRecordSchema = v.object({ artifact_count: v.pipe(v.number(), v.safeInteger()) });
export type ArtifactCountRecord = Readonly<v.InferOutput<typeof ArtifactCountRecordSchema>>;

export const SessionRecordSchema = v.object({
    scope_key: v.string(),
    tenant_id: v.string(),
    project_id: v.string(),
    session_id: v.string(),
    created_by: v.string(),
    runtime_id: v.string(),
    agent_id: v.string(),
    binding_id: v.string(),
    directory_id: v.string(),
    config_revision: v.pipe(v.number(), v.safeInteger()),
    binding_created_at: v.pipe(v.number(), v.safeInteger()),
    title: v.string(),
    native_history_json: v.nullable(v.string()),
    recording_level: v.picklist(["full", "summary"]),
    retention_milliseconds: v.pipe(v.number(), v.safeInteger()),
    idempotency_retention_milliseconds: v.pipe(v.number(), v.safeInteger()),
    hot_event_limit: v.pipe(v.number(), v.safeInteger()),
    content_limit_bytes: v.pipe(v.number(), v.safeInteger()),
    lifecycle: v.picklist(["ready", "deleting", "deleted"]),
    delete_requested_at: v.pipe(v.number(), v.safeInteger()),
    delete_completed_at: v.pipe(v.number(), v.safeInteger()),
    created_at: v.pipe(v.number(), v.safeInteger()),
    updated_at: v.pipe(v.number(), v.safeInteger()),
    next_sequence: v.pipe(v.number(), v.safeInteger()),
    minimum_sequence: v.pipe(v.number(), v.safeInteger()),
});
export type SessionRecord = Readonly<v.InferOutput<typeof SessionRecordSchema>>;

export const SessionBindingRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    binding_id: v.string(),
    runtime_id: v.string(),
    agent_ref: v.string(),
    workspace_ref: v.string(),
    config_revision: v.pipe(v.number(), v.safeInteger()),
    created_at: v.pipe(v.number(), v.safeInteger()),
});
export type SessionBindingRecord = Readonly<v.InferOutput<typeof SessionBindingRecordSchema>>;

export const SessionConfigurationRecordSchema = v.object({
    config_options_json: v.string(),
    config_revision: v.pipe(v.number(), v.safeInteger()),
    updated_at: v.pipe(v.number(), v.safeInteger()),
});

export const TurnRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    command_id: v.string(),
    turn_id: v.string(),
    binding_id: v.string(),
    idempotency_key: v.string(),
    request_hash: v.string(),
    command_json: v.string(),
    state: v.picklist(["queued", "running", "succeeded", "failed", "cancelled", "indeterminate"]),
    response: v.string(),
    attempt_id: v.nullable(v.string()),
    started_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    completed_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    stop_reason: v.nullable(v.string()),
    error_code: v.nullable(v.string()),
    error_message: v.nullable(v.string()),
    created_at: v.pipe(v.number(), v.safeInteger()),
    updated_at: v.pipe(v.number(), v.safeInteger()),
});
export type TurnRecord = Readonly<v.InferOutput<typeof TurnRecordSchema>>;

export const TurnMessageAnchorRecordSchema = v.object({
    message_id: v.string(),
});

export const TurnRuntimeRecordSchema = v.object({ ...TurnRecordSchema.entries, runtime_id: v.string() });
export type TurnRuntimeRecord = Readonly<v.InferOutput<typeof TurnRuntimeRecordSchema>>;

export const CommandReceiptRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    command_kind: v.string(),
    idempotency_key: v.string(),
    request_hash: v.string(),
    result_id: v.string(),
    accepted_at: v.pipe(v.number(), v.safeInteger()),
});
export type CommandReceiptRecord = Readonly<v.InferOutput<typeof CommandReceiptRecordSchema>>;

export const CommandResultReceiptRecordSchema = v.pick(CommandReceiptRecordSchema, ["request_hash", "result_id"]);

export const AttemptRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    attempt_id: v.string(),
    turn_id: v.string(),
    binding_id: v.string(),
    state: v.picklist(["dispatching", "running", "waiting_input", "succeeded", "failed", "cancelled", "indeterminate"]),
    started_at: v.pipe(v.number(), v.safeInteger()),
    waiting_interaction_ids_json: v.string(),
    completed_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    stop_reason: v.nullable(v.string()),
    error_code: v.nullable(v.string()),
    error_message: v.nullable(v.string()),
    updated_at: v.pipe(v.number(), v.safeInteger()),
});
export type AttemptRecord = Readonly<v.InferOutput<typeof AttemptRecordSchema>>;

export const InteractionRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    interaction_id: v.string(),
    turn_id: v.string(),
    attempt_id: v.string(),
    request_json: v.string(),
    state: v.picklist(["pending", "responded", "resolved", "expired", "cancelled"]),
    response_json: v.nullable(v.string()),
    responder_id: v.nullable(v.string()),
    responded_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    resolved_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
});
export type InteractionRecord = Readonly<v.InferOutput<typeof InteractionRecordSchema>>;

export const PendingWorkRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    work_id: v.string(),
    work_kind: v.picklist(["archive", "delete", "dispatch", "interaction_response", "projection"]),
    runtime_id: v.string(),
    interaction_id: v.nullable(v.string()),
    delivery_payload: v.nullable(v.string()),
    state: v.picklist(["pending", "running", "completed", "retryable", "failed"]),
    queued_at: v.pipe(v.number(), v.safeInteger()),
    started_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    completed_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    next_attempt_at: v.nullable(v.pipe(v.number(), v.safeInteger())),
    attempt_count: v.pipe(v.number(), v.safeInteger()),
    error_code: v.nullable(v.string()),
    error_message: v.nullable(v.string()),
});
export type PendingWorkRecord = Readonly<v.InferOutput<typeof PendingWorkRecordSchema>>;

const SessionEventRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    sequence_number: v.pipe(v.number(), v.safeInteger()),
    event_id: v.string(),
    payload_hash: v.string(),
    source_kind: v.picklist(["attempt", "runtime"]),
    source_id: v.string(),
    source_seq: v.string(),
    payload: v.nullable(v.string()),
    archive_segment_id: v.string(),
    recorded_at: v.pipe(v.number(), v.safeInteger()),
});

const ActivityRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    command_id: v.string(),
    attempt_id: v.string(),
    activity_id: v.string(),
    summary_json: v.string(),
    detail_kind: v.picklist(["available", "truncated", "unrecorded"]),
    detail_artifact_id: v.nullable(v.string()),
    hot_detail: v.nullable(v.string()),
    captured_bytes: v.pipe(v.number(), v.safeInteger()),
    original_bytes: v.pipe(v.number(), v.safeInteger()),
    event_sequence: v.pipe(v.number(), v.safeInteger()),
});

const ArtifactRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    artifact_id: v.string(),
    owner_id: v.string(),
    media_type: v.string(),
    state: v.picklist(["uploading", "available", "deleting", "deleted", "failed", "expired"]),
    byte_length: v.pipe(v.number(), v.safeInteger()),
    sha256: v.string(),
    chunks_json: v.nullable(v.string()),
});

const ArchiveSegmentRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    segment_id: v.string(),
    first_sequence: v.pipe(v.number(), v.safeInteger()),
    last_sequence: v.pipe(v.number(), v.safeInteger()),
    event_count: v.pipe(v.number(), v.safeInteger()),
    media_type: v.string(),
    state: v.picklist(["pending", "uploaded", "published", "deleting", "deleted"]),
    byte_length: v.pipe(v.number(), v.safeInteger()),
    sha256: v.string(),
    chunks_json: v.nullable(v.string()),
});

const ArchiveJobRecordSchema = v.object({
    scope_key: v.string(),
    session_id: v.string(),
    target_id: v.string(),
    archive_kind: v.picklist(["activity", "event"]),
    owner_id: v.string(),
    media_type: v.string(),
    hot_payload: v.string(),
    attempts: v.pipe(v.number(), v.safeInteger()),
    last_error: v.string(),
});

export const ArchiveJobPayloadSchema = v.pick(ArchiveJobRecordSchema, [
    "target_id",
    "archive_kind",
    "owner_id",
    "media_type",
    "hot_payload",
]);
export type ArchiveJobPayload = Readonly<v.InferOutput<typeof ArchiveJobPayloadSchema>>;

export const ArchiveJobIdentitySchema = v.pick(ArchiveJobRecordSchema, ["target_id"]);
export type ArchiveJobIdentity = Readonly<v.InferOutput<typeof ArchiveJobIdentitySchema>>;

export const ArchiveBacklogSchema = v.object({
    pending_jobs: v.pipe(v.number(), v.safeInteger()),
    pending_bytes: v.pipe(v.number(), v.safeInteger()),
});
export type ArchiveBacklog = Readonly<v.InferOutput<typeof ArchiveBacklogSchema>>;

export const ArtifactManifestRecordSchema = v.pick(ArtifactRecordSchema, [
    "state",
    "byte_length",
    "sha256",
    "chunks_json",
]);
export type ArtifactManifestRecord = Readonly<v.InferOutput<typeof ArtifactManifestRecordSchema>>;

export const SegmentManifestRecordSchema = v.pick(ArchiveSegmentRecordSchema, [
    "state",
    "byte_length",
    "sha256",
    "chunks_json",
]);
export type SegmentManifestRecord = Readonly<v.InferOutput<typeof SegmentManifestRecordSchema>>;

export const ArchivePayloadSchema = v.pick(ArchiveJobRecordSchema, ["hot_payload"]);
export type ArchivePayload = Readonly<v.InferOutput<typeof ArchivePayloadSchema>>;

export const ContentManifestRecordSchema = v.pick(ArtifactRecordSchema, ["chunks_json"]);
export type ContentManifestRecord = Readonly<v.InferOutput<typeof ContentManifestRecordSchema>>;

export const PendingArchivePayloadSchema = v.pick(ArchiveJobRecordSchema, ["target_id", "hot_payload"]);
export type PendingArchivePayload = Readonly<v.InferOutput<typeof PendingArchivePayloadSchema>>;

export const BindingIdentitySchema = v.pick(SessionBindingRecordSchema, ["binding_id"]);
export type BindingIdentity = Readonly<v.InferOutput<typeof BindingIdentitySchema>>;

export const CommandIdentitySchema = v.pick(TurnRecordSchema, ["command_id"]);
export type CommandIdentity = Readonly<v.InferOutput<typeof CommandIdentitySchema>>;

export const RuntimeIdentitySchema = v.pick(SessionBindingRecordSchema, ["runtime_id"]);
export type RuntimeIdentity = Readonly<v.InferOutput<typeof RuntimeIdentitySchema>>;

export const TurnAttemptRecordSchema = v.pick(TurnRecordSchema, ["attempt_id", "state"]);
export type TurnAttemptRecord = Readonly<v.InferOutput<typeof TurnAttemptRecordSchema>>;

export const CommittedEventRecordSchema = v.pick(SessionEventRecordSchema, [
    "sequence_number",
    "event_id",
    "payload_hash",
    "source_kind",
    "source_id",
    "source_seq",
    "payload",
    "archive_segment_id",
    "recorded_at",
]);
export type CommittedEventRecord = Readonly<v.InferOutput<typeof CommittedEventRecordSchema>>;

export const SourceSequenceRecordSchema = v.pick(SessionEventRecordSchema, ["source_seq"]);
export type SourceSequenceRecord = Readonly<v.InferOutput<typeof SourceSequenceRecordSchema>>;

export const RecordPresenceSchema = v.object({ "1": v.literal(1) });
export type RecordPresence = Readonly<v.InferOutput<typeof RecordPresenceSchema>>;

export const EventSequenceRecordSchema = v.pick(SessionRecordSchema, ["next_sequence"]);
export type EventSequenceRecord = Readonly<v.InferOutput<typeof EventSequenceRecordSchema>>;

export const AttemptStateRecordSchema = v.pick(AttemptRecordSchema, ["state"]);
export type AttemptStateRecord = Readonly<v.InferOutput<typeof AttemptStateRecordSchema>>;

export const InteractionIdentitySchema = v.pick(InteractionRecordSchema, ["interaction_id"]);
export type InteractionIdentity = Readonly<v.InferOutput<typeof InteractionIdentitySchema>>;

export const DefaultBindingRecordSchema = v.pick(SessionRecordSchema, [
    "runtime_id",
    "agent_id",
    "directory_id",
    "binding_id",
    "config_revision",
]);
export type DefaultBindingRecord = Readonly<v.InferOutput<typeof DefaultBindingRecordSchema>>;

export const BindingConfigurationRecordSchema = v.pick(SessionBindingRecordSchema, [
    "runtime_id",
    "agent_ref",
    "workspace_ref",
    "config_revision",
]);
export type BindingConfigurationRecord = Readonly<v.InferOutput<typeof BindingConfigurationRecordSchema>>;

export const InteractionRuntimeRecordSchema = v.object({
    ...InteractionRecordSchema.entries,
    runtime_id: SessionBindingRecordSchema.entries.runtime_id,
});
export type InteractionRuntimeRecord = Readonly<v.InferOutput<typeof InteractionRuntimeRecordSchema>>;

export const ActivityDetailRecordSchema = v.pick(ActivityRecordSchema, [
    "detail_kind",
    "detail_artifact_id",
    "hot_detail",
    "captured_bytes",
    "original_bytes",
]);
export type ActivityDetailRecord = Readonly<v.InferOutput<typeof ActivityDetailRecordSchema>>;

export const TurnActivityRecordSchema = v.pick(ActivityRecordSchema, ["attempt_id", "summary_json", "detail_kind"]);
export type TurnActivityRecord = Readonly<v.InferOutput<typeof TurnActivityRecordSchema>>;

export const SessionCountSchema = v.object({
    active_sessions: v.pipe(v.number(), v.safeInteger()),
});

export const ActivitySummaryRecordSchema = v.pick(ActivityRecordSchema, [
    "attempt_id",
    "summary_json",
    "event_sequence",
]);
export type ActivitySummaryRecord = Readonly<v.InferOutput<typeof ActivitySummaryRecordSchema>>;

export const ActivityArtifactRecordSchema = v.pick(ActivityRecordSchema, [
    "attempt_id",
    "activity_id",
    "detail_artifact_id",
    "hot_detail",
]);
export type ActivityArtifactRecord = Readonly<v.InferOutput<typeof ActivityArtifactRecordSchema>>;
