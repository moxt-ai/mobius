import {
    type AttemptRecord,
    AttemptRecordSchema,
    type AttemptStateRecord,
    AttemptStateRecordSchema,
    type BindingConfigurationRecord,
    BindingConfigurationRecordSchema,
    type DefaultBindingRecord,
    DefaultBindingRecordSchema,
    type EventSequenceRecord,
    EventSequenceRecordSchema,
    type InteractionIdentity,
    InteractionIdentitySchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type TurnRecord,
    TurnRecordSchema,
} from "../../entity/session/session-records.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";

export class SessionEventProjectorStorage {
    readonly #database: SessionSqlDatabase;
    constructor(cx: { readonly gateways: { readonly database: SessionSqlDatabase } }) {
        const { database } = cx.gateways;
        this.#database = database;
    }

    readonly findTurnByCommand = (scopeKey: string, sessionId: string, commandId: string): TurnRecord | undefined =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
                [scopeKey, sessionId, commandId],
            ),
        )[0];

    readonly insertRunningAttempt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
        readonly turnId: string;
        readonly bindingId: string;
        readonly startedAt: number;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO attempts (
           scope_key, session_id, attempt_id, turn_id, binding_id, state,
           started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.attemptId,
                input.turnId,
                input.bindingId,
                input.startedAt,
                input.updatedAt,
            ],
        );

    readonly startTurn = (input: {
        readonly attemptId: string | null;
        readonly startedAt: number | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET state = 'running', attempt_id = ?, started_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [input.attemptId, input.startedAt, input.updatedAt, input.scopeKey, input.sessionId, input.commandId],
        );

    readonly appendTurnResponse = (input: {
        readonly text: string;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET response = substr(response || ?, 1, 100000), updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [input.text, input.updatedAt, input.scopeKey, input.sessionId, input.commandId],
        );

    readonly findEventSequence = (scopeKey: string, sessionId: string): EventSequenceRecord | undefined =>
        decodeStorageRows(
            EventSequenceRecordSchema,
            this.#database.query(
                `SELECT next_sequence FROM sessions
         WHERE scope_key = ? AND session_id = ?`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly upsertActivity = (input: {
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

    readonly findAttempt = (scopeKey: string, sessionId: string, attemptId: string): AttemptRecord | undefined =>
        decodeStorageRows(
            AttemptRecordSchema,
            this.#database.query(
                `SELECT * FROM attempts
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
                [scopeKey, sessionId, attemptId],
            ),
        )[0];

    readonly findInteraction = (
        scopeKey: string,
        sessionId: string,
        interactionId: string,
    ): InteractionRecord | undefined =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
                [scopeKey, sessionId, interactionId],
            ),
        )[0];

    readonly insertPendingInteraction = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
        readonly turnId: string;
        readonly attemptId: string;
        readonly requestJson: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO interactions (
           scope_key, session_id, interaction_id, turn_id, attempt_id,
           request_json, state
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [input.scopeKey, input.sessionId, input.interactionId, input.turnId, input.attemptId, input.requestJson],
        );

    readonly cancelInteraction = (input: {
        readonly resolvedAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE interactions
           SET state = 'cancelled', resolved_at = ?
           WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
            [input.resolvedAt, input.scopeKey, input.sessionId, input.interactionId],
        );

    readonly markAttemptWaitingForInput = (input: {
        readonly waitingInteractionIdsJson: string;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = 'waiting_input', waiting_interaction_ids_json = ?,
             updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [input.waitingInteractionIdsJson, input.updatedAt, input.scopeKey, input.sessionId, input.attemptId],
        );

    readonly findAttemptState = (
        scopeKey: string,
        sessionId: string,
        attemptId: string,
    ): AttemptStateRecord | undefined =>
        decodeStorageRows(
            AttemptStateRecordSchema,
            this.#database.query(
                `SELECT state FROM attempts
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
                [scopeKey, sessionId, attemptId],
            ),
        )[0];

    readonly resolveInteraction = (input: {
        readonly resolvedAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE interactions
         SET state = 'resolved', resolved_at = ?
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
            [input.resolvedAt, input.scopeKey, input.sessionId, input.interactionId],
        );

    readonly listUnresolvedInteractionIds = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): readonly InteractionIdentity[] =>
        decodeStorageRows(
            InteractionIdentitySchema,
            this.#database.query(
                `SELECT interaction_id FROM interactions
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
           AND state IN ('pending', 'responded')
         ORDER BY interaction_id`,
                [input.scopeKey, input.sessionId, input.attemptId],
            ),
        );

    readonly updateActiveAttemptInteractions = (input: {
        readonly state: string;
        readonly waitingInteractionIdsJson: string;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = ?, waiting_interaction_ids_json = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
           AND state IN ('running', 'waiting_input')`,
            [
                input.state,
                input.waitingInteractionIdsJson,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.attemptId,
            ],
        );

    readonly completeTurn = (input: {
        readonly state: string;
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET state = ?, completed_at = ?, stop_reason = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [
                input.state,
                input.completedAt,
                input.stopReason,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.commandId,
            ],
        );

    readonly completeTurnAttempts = (input: {
        readonly state: string;
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = ?, completed_at = ?, stop_reason = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('running', 'waiting_input', 'indeterminate')`,
            [
                input.state,
                input.completedAt,
                input.stopReason,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.turnId,
            ],
        );

    readonly cancelTurnInteractions = (input: {
        readonly resolvedAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE interactions
         SET state = 'cancelled', resolved_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('pending', 'responded')`,
            [input.resolvedAt, input.scopeKey, input.sessionId, input.turnId],
        );

    readonly insertFailedAttempt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
        readonly turnId: string;
        readonly bindingId: string;
        readonly startedAt: number;
        readonly completedAt: number | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO attempts (
             scope_key, session_id, attempt_id, turn_id, binding_id, state,
             started_at, completed_at, error_code, error_message, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.attemptId,
                input.turnId,
                input.bindingId,
                input.startedAt,
                input.completedAt,
                input.errorCode,
                input.errorMessage,
                input.updatedAt,
            ],
        );

    readonly failTurn = (input: {
        readonly completedAt: number | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly attemptSourceId: string | null;
        readonly now: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, attempt_id = COALESCE(attempt_id, ?),
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [
                input.completedAt,
                input.errorCode,
                input.errorMessage,
                input.attemptSourceId,
                input.now,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.commandId,
            ],
        );

    readonly failTurnAttempts = (input: {
        readonly completedAt: number | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state IN ('running', 'waiting_input', 'indeterminate')`,
            [
                input.completedAt,
                input.errorCode,
                input.errorMessage,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.turnId,
            ],
        );

    readonly findSessionBinding = (scopeKey: string, sessionId: string): DefaultBindingRecord | undefined =>
        decodeStorageRows(
            DefaultBindingRecordSchema,
            this.#database.query(
                `SELECT runtime_id, agent_id, directory_id, binding_id, config_revision
         FROM sessions WHERE scope_key = ? AND session_id = ?`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly findBinding = (
        scopeKey: string,
        sessionId: string,
        bindingId: string,
    ): BindingConfigurationRecord | undefined =>
        decodeStorageRows(
            BindingConfigurationRecordSchema,
            this.#database.query(
                `SELECT runtime_id, agent_ref, workspace_ref, config_revision
         FROM session_bindings
         WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
                [scopeKey, sessionId, bindingId],
            ),
        )[0];

    readonly insertBinding = (input: {
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

    readonly updateSessionBindingRevision = (input: {
        readonly bindingId: string;
        readonly configRevision: number;
        readonly bindingCreatedAt: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET binding_id = ?, config_revision = ?, binding_created_at = ?,
             updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
            [
                input.bindingId,
                input.configRevision,
                input.bindingCreatedAt,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
            ],
        );

    readonly updateSessionTitle = (input: {
        readonly title: string;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions SET title = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
            [input.title, input.updatedAt, input.scopeKey, input.sessionId],
        );
}
