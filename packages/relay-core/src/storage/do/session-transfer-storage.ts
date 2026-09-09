import { encodeAgentActivityEvent } from "@moxt-ai/mobius-protocol";
import type { SessionImportPlan } from "../../entity/do/session-import.ts";
import {
    type ActivityArtifactRecord,
    ActivityArtifactRecordSchema,
    type ActivitySummaryRecord,
    ActivitySummaryRecordSchema,
    type CommandReceiptRecord,
    CommandReceiptRecordSchema,
    type CommittedEventRecord,
    CommittedEventRecordSchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type SessionBindingRecord,
    SessionBindingRecordSchema,
    type TurnRecord,
    TurnRecordSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionArchiveStorage } from "./session-archive-storage.ts";

export class SessionTransferStorage {
    readonly #database: DoSqlDatabase;
    readonly #archive: SessionArchiveStorage;
    constructor(cx: {
        readonly doDatabase: DoSqlDatabase;
        readonly storages: { readonly archive: SessionArchiveStorage };
    }) {
        const { doDatabase: database } = cx;
        this.#database = database;
        this.#archive = cx.storages.archive;
    }

    readonly restoreImport = (plan: SessionImportPlan): void => {
        this.#database.transaction(() => {
            const scope = { scopeKey: plan.scopeKey, sessionId: plan.sessionId };
            if (plan.nativeHistory !== null) {
                this.updateNativeHistory({ ...scope, nativeHistoryJson: JSON.stringify(plan.nativeHistory) });
            }
            for (const binding of plan.bindings) {
                this.insertBinding({ ...scope, ...binding, createdAt: Date.parse(binding.createdAt) });
            }
            for (const command of plan.commands) {
                this.insertTurn({
                    ...scope,
                    ...command,
                    commandId: command.command.commandId,
                    commandJson: JSON.stringify(command.command),
                });
                this.insertCommandReceipt({
                    ...scope,
                    commandKind: command.command.kind,
                    idempotencyKey: command.idempotencyKey,
                    requestHash: command.requestHash,
                    resultId: command.turnId,
                    acceptedAt: command.createdAt,
                });
                if (command.attemptId !== null && command.startedAt !== null) {
                    this.insertAttempt({
                        ...scope,
                        ...command,
                        attemptId: command.attemptId,
                        startedAt: command.startedAt,
                    });
                }
            }
            for (const interaction of plan.interactions) {
                const state = interaction.state;
                const response =
                    state.kind === "resolved" && state.resolution.kind === "response_applied" ? state.resolution : null;
                let resolvedAt: number;
                switch (state.kind) {
                    case "resolved":
                        resolvedAt = Date.parse(state.resolvedAt);
                        break;
                    case "expired":
                        resolvedAt = Date.parse(state.expiredAt);
                        break;
                    case "cancelled":
                        resolvedAt = Date.parse(state.cancelledAt);
                        break;
                    default: {
                        const unreachable: never = state;
                        return unreachable;
                    }
                }
                this.insertInteraction({
                    ...scope,
                    ...interaction,
                    requestJson: JSON.stringify(interaction.request),
                    state: state.kind,
                    responseJson: response === null ? null : JSON.stringify(response.response),
                    responderId: response === null ? null : response.responderId,
                    respondedAt: response === null ? null : Date.parse(response.respondedAt),
                    resolvedAt,
                });
            }
            for (const { activity, artifact } of plan.activities) {
                const detail = activity.event.detail;
                this.insertActivity({
                    ...scope,
                    commandId: activity.event.commandId,
                    attemptId: activity.attemptId,
                    activityId: activity.event.activityId,
                    summaryJson: encodeAgentActivityEvent(activity.event),
                    detailKind: detail.kind,
                    detailArtifactId: detail.kind === "available" ? detail.artifactId : null,
                    hotDetail: artifact?.payload ?? null,
                    capturedBytes: detail.kind === "truncated" ? detail.capturedBytes : 0,
                    originalBytes: detail.kind === "truncated" ? detail.originalBytes : 0,
                    eventSequence: activity.eventSequence,
                });
                if (artifact !== null) {
                    this.#archive.stageArtifact({
                        ...scope,
                        artifactId: artifact.artifactId,
                        ownerId: activity.event.activityId,
                        mediaType: "application/json",
                        hotPayload: artifact.payload,
                    });
                }
            }
            for (const { event, payloadHash, sourceId, archiveSegmentId } of plan.events) {
                this.#archive.stageEvent({
                    ...scope,
                    segmentId: archiveSegmentId,
                    eventId: event.eventId,
                    sequence: Number(event.sequence),
                    mediaType: "application/json",
                    hotPayload: event.payload,
                });
                this.insertEvent({
                    ...scope,
                    sequenceNumber: Number(event.sequence),
                    eventId: event.eventId,
                    payloadHash,
                    sourceKind: event.source.kind,
                    sourceId,
                    sourceSeq: event.source.sourceSeq,
                    payload: event.payload,
                    archiveSegmentId,
                    recordedAt: Date.parse(event.recordedAt),
                });
            }
            this.restoreSessionConfiguration(plan);
            this.restoreBindingRevision({
                ...scope,
                configRevision: plan.configRevision,
                bindingId: plan.targetBindingId,
            });
        });
    };

    readonly listEvents = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly CommittedEventRecord[] =>
        decodeStorageRows(
            CommittedEventRecordSchema,
            this.#database.query(
                `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, archive_segment_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
       ORDER BY sequence_number`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listTurns = (input: { readonly scopeKey: string; readonly sessionId: string }): readonly TurnRecord[] =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ?
       ORDER BY created_at DESC, command_id DESC`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listActivities = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly ActivitySummaryRecord[] =>
        decodeStorageRows(
            ActivitySummaryRecordSchema,
            this.#database.query(
                `SELECT attempt_id, summary_json, event_sequence
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ?
       ORDER BY event_sequence, attempt_id, activity_id`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listActivityArtifacts = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly ActivityArtifactRecord[] =>
        decodeStorageRows(
            ActivityArtifactRecordSchema,
            this.#database.query(
                `SELECT attempt_id, activity_id, detail_artifact_id, hot_detail
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND detail_kind = 'available'
       ORDER BY attempt_id, activity_id`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listBindings = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly SessionBindingRecord[] =>
        decodeStorageRows(
            SessionBindingRecordSchema,
            this.#database.query(
                `SELECT * FROM session_bindings
         WHERE scope_key = ? AND session_id = ?
         ORDER BY created_at, binding_id`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listCommandReceipts = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly CommandReceiptRecord[] =>
        decodeStorageRows(
            CommandReceiptRecordSchema,
            this.#database.query(
                `SELECT * FROM command_receipts
         WHERE scope_key = ? AND session_id = ?
         ORDER BY accepted_at, idempotency_key`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listInteractions = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly InteractionRecord[] =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ?
         ORDER BY interaction_id`,
                [input.scopeKey, input.sessionId],
            ),
        );

    private readonly updateNativeHistory = (input: {
        readonly nativeHistoryJson: string | null;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions SET native_history_json = ?
             WHERE scope_key = ? AND session_id = ?`,
            [input.nativeHistoryJson, input.scopeKey, input.sessionId],
        );

    private readonly insertBinding = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly bindingId: string;
        readonly runtimeId: string;
        readonly agentRef: string;
        readonly workspaceRef: string;
        readonly configRevision: number;
        readonly createdAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO session_bindings (
               scope_key, session_id, binding_id, runtime_id, agent_ref,
               workspace_ref, config_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.bindingId,
                input.runtimeId,
                input.agentRef,
                input.workspaceRef,
                input.configRevision,
                input.createdAt,
            ],
        );

    private readonly insertTurn = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly turnId: string;
        readonly bindingId: string;
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly commandJson: string;
        readonly state: string;
        readonly response: string;
        readonly attemptId: string | null;
        readonly startedAt: number | null;
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly createdAt: number;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO turns (
               scope_key, session_id, command_id, turn_id, binding_id,
               idempotency_key, request_hash, command_json, state,
               response, attempt_id, started_at, completed_at,
               stop_reason, error_code, error_message, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.commandId,
                input.turnId,
                input.bindingId,
                input.idempotencyKey,
                input.requestHash,
                input.commandJson,
                input.state,
                input.response,
                input.attemptId,
                input.startedAt,
                input.completedAt,
                input.stopReason,
                input.errorCode,
                input.errorMessage,
                input.createdAt,
                input.updatedAt,
            ],
        );

    private readonly insertCommandReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandKind: string;
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly resultId: string;
        readonly acceptedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO command_receipts (
               scope_key, session_id, command_kind, idempotency_key,
               request_hash, result_id, accepted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.commandKind,
                input.idempotencyKey,
                input.requestHash,
                input.resultId,
                input.acceptedAt,
            ],
        );

    private readonly insertAttempt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
        readonly turnId: string;
        readonly bindingId: string;
        readonly state: string;
        readonly startedAt: number;
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO attempts (
                 scope_key, session_id, attempt_id, turn_id, binding_id,
                 state, started_at, completed_at, stop_reason, error_code,
                 error_message, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.attemptId,
                input.turnId,
                input.bindingId,
                input.state,
                input.startedAt,
                input.completedAt,
                input.stopReason,
                input.errorCode,
                input.errorMessage,
                input.updatedAt,
            ],
        );

    private readonly insertInteraction = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
        readonly turnId: string;
        readonly attemptId: string;
        readonly requestJson: string;
        readonly state: string;
        readonly responseJson: string | null;
        readonly responderId: string | null;
        readonly respondedAt: number | null;
        readonly resolvedAt: number | null;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO interactions (
               scope_key, session_id, interaction_id, turn_id, attempt_id,
               request_json, state, response_json, responder_id, responded_at,
               resolved_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.interactionId,
                input.turnId,
                input.attemptId,
                input.requestJson,
                input.state,
                input.responseJson,
                input.responderId,
                input.respondedAt,
                input.resolvedAt,
            ],
        );

    private readonly insertActivity = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly attemptId: string;
        readonly activityId: string;
        readonly summaryJson: string;
        readonly detailKind: string;
        readonly detailArtifactId: string | null;
        readonly hotDetail: string | null;
        readonly capturedBytes: number;
        readonly originalBytes: number;
        readonly eventSequence: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO tool_call_views (
               scope_key, session_id, command_id, attempt_id, activity_id, summary_json,
               detail_kind, detail_artifact_id, hot_detail, captured_bytes,
               original_bytes, event_sequence
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.commandId,
                input.attemptId,
                input.activityId,
                input.summaryJson,
                input.detailKind,
                input.detailArtifactId,
                input.hotDetail,
                input.capturedBytes,
                input.originalBytes,
                input.eventSequence,
            ],
        );

    private readonly insertEvent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly sequenceNumber: number;
        readonly eventId: string;
        readonly payloadHash: string;
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceSeq: string;
        readonly payload: string | null;
        readonly archiveSegmentId: string;
        readonly recordedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO session_events (
               scope_key, session_id, sequence_number, event_id, payload_hash,
               source_kind, source_id, source_seq, payload, archive_segment_id,
               recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.sequenceNumber,
                input.eventId,
                input.payloadHash,
                input.sourceKind,
                input.sourceId,
                input.sourceSeq,
                input.payload,
                input.archiveSegmentId,
                input.recordedAt,
            ],
        );

    private readonly restoreSessionConfiguration = (input: {
        readonly configRevision: number;
        readonly minimumSequence: number;
        readonly nextSequence: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
           SET config_revision = ?, minimum_sequence = ?, next_sequence = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ?`,
            [
                input.configRevision,
                input.minimumSequence,
                input.nextSequence,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
            ],
        );
    private readonly restoreBindingRevision = (input: {
        readonly configRevision: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly bindingId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE session_bindings SET config_revision = ?
           WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
            [input.configRevision, input.scopeKey, input.sessionId, input.bindingId],
        );
}
