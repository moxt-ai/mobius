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
import type { SessionRecord, TurnRecord } from "../../entity/session/session-records.ts";
import { SessionEventProjectorStorage } from "../../storage/session/session-event-projector-storage.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/session/sqlite-row.ts";
import { SessionRuntimeError } from "./session.ts";
import { identifierArrayFromJson, interactionFromRow, type PreparedEvent } from "./session-records.ts";

export class SessionEventProjector {
    readonly #storage: SessionEventProjectorStorage;

    constructor(database: SessionSqlDatabase) {
        this.#storage = new SessionEventProjectorStorage(database);
    }
    readonly prepareEvent = (
        session: SessionRecord,
        envelope: SessionEventEnvelope,
        event: RecordedSessionEvent,
    ): PreparedEvent => {
        if (event.kind !== AGENT_ACTIVITY_KIND) {
            return { activityDetail: null, event, payload: envelope.payload };
        }
        if (event.detail.kind === "available") {
            throw new SessionRuntimeError("session_conflict", "A daemon cannot submit an archive reference");
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
    ): TurnRecord => {
        const row = this.#storage.findTurnByCommand(key, sessionId, commandId);
        if (row === undefined || !states.includes(rowString(row, "state"))) {
            throw new SessionRuntimeError("session_conflict", "The event does not match the current command state");
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
            const command = this.requireCommandState(key, sessionId, event.commandId, ["queued"]);
            this.#storage.insertRunningAttempt({
                scopeKey: key,
                sessionId: sessionId,
                attemptId: event.attemptId,
                turnId: rowString(command, "turn_id"),
                bindingId: rowString(command, "binding_id"),
                startedAt: now,
                updatedAt: now,
            });
            this.#storage.startTurn({
                attemptId: event.attemptId,
                startedAt: now,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                commandId: event.commandId,
            });
            return;
        }
        // A reconnecting owner can drain its contiguous durable outbox without
        // reviving an indeterminate Attempt. Only a terminal event resolves it.
        if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
            this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            this.#storage.appendTurnResponse({
                text: event.text,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                commandId: event.commandId,
            });
            return;
        }
        if (event.kind === AGENT_ACTIVITY_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            const attemptId = rowNullableString(command, "attempt_id");
            if (attemptId === null) {
                throw new SessionRuntimeError("session_conflict", "The ToolCall has no owning Attempt");
            }
            const sequenceRow = this.#storage.findEventSequence(key, sessionId);
            if (sequenceRow === undefined) {
                throw new SessionRuntimeError("session_storage_unavailable", "The session state is unavailable");
            }
            const detail = event.detail;
            const detailArtifactId = detail.kind === "available" ? detail.artifactId : null;
            const hotDetail = prepared.activityDetail?.payload ?? null;
            const capturedBytes = detail.kind === "truncated" ? detail.capturedBytes : 0;
            const originalBytes = detail.kind === "truncated" ? detail.originalBytes : 0;
            const detailKind =
                detail.kind === "available" ? "available" : detail.kind === "truncated" ? "truncated" : "unrecorded";
            this.#storage.upsertActivity({
                scopeKey: key,
                sessionId: sessionId,
                commandId: event.commandId,
                attemptId: attemptId,
                activityId: event.activityId,
                summaryJson: encodeAgentActivityEvent(event),
                detailKind: detailKind,
                detailArtifactId: detailArtifactId,
                hotDetail: hotDetail,
                capturedBytes: capturedBytes,
                originalBytes: originalBytes,
                eventSequence: rowNumber(sequenceRow, "next_sequence"),
            });
            return;
        }
        if (event.kind === SESSION_PERMISSION_REQUESTED_KIND || event.kind === SESSION_ELICITATION_REQUESTED_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            const attemptId = rowNullableString(command, "attempt_id");
            if (attemptId === null) {
                throw new SessionRuntimeError("session_conflict", "The running Turn has no Attempt identity");
            }
            const attempt = this.#storage.findAttempt(key, sessionId, attemptId);
            if (
                attempt === undefined ||
                !["running", "waiting_input", "indeterminate"].includes(rowString(attempt, "state"))
            ) {
                throw new SessionRuntimeError("session_conflict", "The Interaction does not belong to a live Attempt");
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
            const existing = this.#storage.findInteraction(key, sessionId, event.interactionId);
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
            this.#storage.insertPendingInteraction({
                scopeKey: key,
                sessionId: sessionId,
                interactionId: event.interactionId,
                turnId: rowString(command, "turn_id"),
                attemptId: attemptId,
                requestJson: requestJson,
            });
            if (rowString(attempt, "state") === "indeterminate") {
                this.#storage.cancelInteraction({
                    resolvedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    interactionId: event.interactionId,
                });
                return;
            }
            const interactionIds = [
                ...identifierArrayFromJson(rowString(attempt, "waiting_interaction_ids_json"), "waiting Interaction"),
                event.interactionId,
            ];
            this.#storage.markAttemptWaitingForInput({
                waitingInteractionIdsJson: JSON.stringify(interactionIds),
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                attemptId: attemptId,
            });
            return;
        }
        if (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
            const interaction = this.#storage.findInteraction(key, sessionId, event.interactionId);
            if (interaction === undefined) {
                throw new SessionRuntimeError("interaction_not_found", "The Runtime resolved an unknown Interaction");
            }
            const interactionState = rowString(interaction, "state");
            const interactionRequest = interactionFromRow(interaction).request;
            if (interactionState === "cancelled") {
                const attempt = this.#storage.findAttemptState(key, sessionId, rowString(interaction, "attempt_id"));
                if (attempt !== undefined && rowString(attempt, "state") === "indeterminate") {
                    return;
                }
            }
            const urlElicitation = interactionRequest.kind === "elicitation" && interactionRequest.mode === "url";
            if (event.kind === SESSION_ELICITATION_RESOLVED_KIND && event.action === "accept" && urlElicitation) {
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
                throw new SessionRuntimeError("interaction_conflict", "The Interaction is already terminal");
            }
            this.#storage.resolveInteraction({
                resolvedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                interactionId: event.interactionId,
            });
            const attemptId = rowString(interaction, "attempt_id");
            const remaining = this.#storage.listUnresolvedInteractionIds({
                scopeKey: key,
                sessionId: sessionId,
                attemptId: attemptId,
            });
            const remainingIds = remaining.map((row) => rowString(row, "interaction_id"));
            this.#storage.updateActiveAttemptInteractions({
                state: remainingIds.length === 0 ? "running" : "waiting_input",
                waitingInteractionIdsJson: JSON.stringify(remainingIds),
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                attemptId: attemptId,
            });
            return;
        }
        if (event.kind === SESSION_COMPLETED_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            this.#storage.completeTurn({
                state: event.stopReason === "cancelled" ? "cancelled" : "succeeded",
                completedAt: now,
                stopReason: event.stopReason,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                commandId: event.commandId,
            });
            this.#storage.completeTurnAttempts({
                state: event.stopReason === "cancelled" ? "cancelled" : "succeeded",
                completedAt: now,
                stopReason: event.stopReason,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                turnId: rowString(command, "turn_id"),
            });
            this.#storage.cancelTurnInteractions({
                resolvedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                turnId: rowString(command, "turn_id"),
            });
            return;
        }
        if (event.kind === SESSION_FAILED_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, [
                "queued",
                "running",
                "indeterminate",
            ]);
            if (rowString(command, "state") === "queued") {
                if (attemptSourceId === null) {
                    throw new SessionRuntimeError(
                        "event_source_conflict",
                        "A failed dispatch has no Attempt source identity",
                    );
                }
                this.#storage.insertFailedAttempt({
                    scopeKey: key,
                    sessionId: sessionId,
                    attemptId: attemptSourceId,
                    turnId: rowString(command, "turn_id"),
                    bindingId: rowString(command, "binding_id"),
                    startedAt: now,
                    completedAt: now,
                    errorCode: event.code,
                    errorMessage: event.message,
                    updatedAt: now,
                });
            }
            this.#storage.failTurn({
                completedAt: now,
                errorCode: event.code,
                errorMessage: event.message,
                attemptSourceId: attemptSourceId,
                now: now,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                commandId: rowString(command, "command_id"),
            });
            this.#storage.failTurnAttempts({
                completedAt: now,
                errorCode: event.code,
                errorMessage: event.message,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                turnId: rowString(command, "turn_id"),
            });
            this.#storage.cancelTurnInteractions({
                resolvedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                turnId: rowString(command, "turn_id"),
            });
            return;
        }
        if (event.kind === SESSION_CONFIG_UPDATED_KIND) {
            const session = this.#storage.findSessionBinding(key, sessionId);
            if (session === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The Session configuration binding is unavailable",
                );
            }
            const existing = this.#storage.findBinding(key, sessionId, event.requestId);
            const configRevision = rowNumber(session, "config_revision") + 1;
            if (existing !== undefined) {
                if (
                    rowString(existing, "runtime_id") !== rowString(session, "runtime_id") ||
                    rowString(existing, "agent_ref") !== rowString(session, "agent_id") ||
                    rowString(existing, "workspace_ref") !== rowString(session, "directory_id") ||
                    rowNumber(existing, "config_revision") !== configRevision
                ) {
                    throw new SessionRuntimeError(
                        "session_conflict",
                        "The configuration request identity is already a different binding",
                    );
                }
            } else {
                this.#storage.insertBinding({
                    scopeKey: key,
                    sessionId: sessionId,
                    bindingId: event.requestId,
                    runtimeId: rowString(session, "runtime_id"),
                    agentRef: rowString(session, "agent_id"),
                    workspaceRef: rowString(session, "directory_id"),
                    configRevision: configRevision,
                    createdAt: now,
                });
            }
            this.#storage.updateSessionBindingRevision({
                bindingId: event.requestId,
                configRevision: configRevision,
                bindingCreatedAt: now,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
            });
            return;
        }
        if (event.kind === SESSION_INFO_UPDATED_KIND) {
            this.#storage.updateSessionTitle({
                title: event.title ?? "",
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
            });
        }
    };
}
