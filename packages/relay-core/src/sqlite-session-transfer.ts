import {
  AGENT_ACTIVITY_KIND,
  type CommandReceipt,
  type CommittedSessionEvent,
  decodeCommandReceipt,
  decodeRecordedSessionEvent,
  decodeSessionPromptCommand,
  encodeAgentActivityEvent,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { encodeBase64, sha256 } from "./session-archive-codec.ts";
import { decodeSessionImport } from "./session-export-codec.ts";
import {
  CreateSessionRequest,
  type ProjectScope,
  type SessionExport,
  type SessionRuntime,
  SessionRuntimeError,
  type SessionSummary,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";
import type { SqliteSessionArchive } from "./sqlite-session-archive.ts";
import {
  attemptSummaryFromRow,
  bindingFromRow,
  committedFromRow,
  interactionFromRow,
  MAX_EXPORT_BYTE_LENGTH,
  scopeKey,
  summaryFromRow,
  turnFromRow,
  validateTimestamp,
} from "./sqlite-session-records.ts";
import type { SqliteSessionStore } from "./sqlite-session-store.ts";

export class SqliteSessionTransfer {
  readonly #archive: SqliteSessionArchive;
  readonly #database: SessionSqlDatabase;
  readonly #store: SqliteSessionStore;

  constructor(
    database: SessionSqlDatabase,
    archive: SqliteSessionArchive,
    store: SqliteSessionStore,
  ) {
    this.#archive = archive;
    this.#database = database;
    this.#store = store;
  }
  readonly exportSession = async (
    scope: ProjectScope,
    sessionId: string,
    signal: AbortSignal,
    readNativeHistory: SessionRuntime["readNativeHistory"],
  ): Promise<SessionExport> => {
    signal.throwIfAborted();
    const sessionRow = this.#store.requireActiveSessionRow(
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
      const payload = await this.#archive.readEventPayload(
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
        state: attemptSummaryFromRow(row) ?? { kind: "queued" },
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
        hot ??
        (await this.#archive.readArtifact(
          scope,
          sessionId,
          artifactId,
          signal,
        ));
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
    const nativeHistory = await readNativeHistory(scope, sessionId, signal);
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
    createSession: SessionRuntime["createSession"],
  ): Promise<SessionSummary> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    const {
      activities,
      agentId,
      artifacts,
      bindingId,
      bindings,
      commands,
      contentLimitBytes,
      createdBy,
      directoryId,
      eventPayloadHashes,
      events,
      hotEventLimit,
      idempotencyRetentionMilliseconds,
      interactions,
      level,
      minimumSequenceNumber,
      nativeHistory,
      nextSequenceNumber,
      retentionMilliseconds,
      runtimeId,
      sessionId,
      title,
    } = await decodeSessionImport(exported, signal);
    if (this.#store.sessionRow(scope, sessionId) !== null) {
      throw new SessionRuntimeError(
        "session_conflict",
        "The imported session identifier is already in use",
      );
    }
    const key = scopeKey(scope);
    let created = false;
    try {
      await createSession(
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
            this.#archive.queueArtifactArchive(
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
          this.#archive.queueEventArchive(
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
    return summaryFromRow(
      this.#store.requireActiveSessionRow(scope, sessionId, now),
    );
  };
}
