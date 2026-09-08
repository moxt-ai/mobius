import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  encodeAgentActivityEvent,
  type Interaction,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIG_UPDATED_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_ELICITATION_RESOLVED_KIND,
  SESSION_FAILED_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PERMISSION_RESOLVED_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";

import { SessionRuntimeError } from "./session-runtime.ts";
import type {
  SessionSqlDatabase,
  SessionSqlRow,
} from "./session-sql-database.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";
import {
  identifierArrayFromJson,
  interactionFromRow,
  type PreparedEvent,
} from "./sqlite-session-records.ts";

export class SqliteSessionEventProjector {
  readonly #database: SessionSqlDatabase;

  constructor(database: SessionSqlDatabase) {
    this.#database = database;
  }
  readonly prepareEvent = (
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

  readonly applyEventProjection = (
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
    // A reconnecting owner can drain its contiguous durable outbox without
    // reviving an indeterminate Attempt. Only a terminal event resolves it.
    if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
      this.requireCommandState(key, sessionId, event.commandId, [
        "running",
        "indeterminate",
      ]);
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
        ["running", "indeterminate"],
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
        ["running", "indeterminate"],
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
        !["running", "waiting_input", "indeterminate"].includes(
          rowString(attempt, "state"),
        )
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
      if (rowString(attempt, "state") === "indeterminate") {
        this.#database.run(
          `UPDATE interactions
           SET state = 'cancelled', resolved_at = ?
           WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
          [now, key, sessionId, event.interactionId],
        );
        return;
      }
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
      if (interactionState === "cancelled") {
        const attempt = this.#database.query(
          `SELECT state FROM attempts
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [key, sessionId, rowString(interaction, "attempt_id")],
        )[0];
        if (
          attempt !== undefined &&
          rowString(attempt, "state") === "indeterminate"
        ) {
          return;
        }
      }
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
        ["running", "indeterminate"],
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
           AND state IN ('running', 'waiting_input', 'indeterminate')`,
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
        ["queued", "running", "indeterminate"],
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
           AND state IN ('running', 'waiting_input', 'indeterminate')`,
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
}
