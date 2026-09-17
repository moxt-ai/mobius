import {
    AGENT_ACTIVITY_KIND,
    AGENT_CONTENT_KIND,
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
import { SessionRuntimeError } from "../../entity/do/session.ts";
import type { SessionEventProjection } from "../../entity/do/session-event-projection.ts";
import type { SessionRecord, TurnRecord } from "../../entity/do/session-records.ts";
import type { SessionEventProjectorStorage } from "../../storage/do/session-event-projector-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import { identifierArrayFromJson, interactionFromRow, type PreparedEvent } from "./session-records.ts";

export class SessionEventProjector {
    readonly #storage: SessionEventProjectorStorage;

    constructor(cx: { readonly storages: { readonly eventProjector: SessionEventProjectorStorage } }) {
        this.#storage = cx.storages.eventProjector;
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

    readonly planEventProjection = (
        key: string,
        sessionId: string,
        prepared: PreparedEvent,
        attemptSourceId: string | null,
    ): SessionEventProjection => {
        const event = prepared.event;
        if (event.kind === SESSION_STARTED_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["queued"]);
            return {
                kind: "start",
                commandId: event.commandId,
                attemptId: event.attemptId,
                turnId: rowString(command, "turn_id"),
                bindingId: rowString(command, "binding_id"),
            };
        }
        // A reconnecting owner can drain its contiguous durable outbox without
        // reviving an indeterminate Attempt. Only a terminal event resolves it.
        if (event.kind === AGENT_MESSAGE_DELTA_KIND) {
            this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            return {
                kind: "response",
                commandId: event.commandId,
                text: event.text,
            };
        }
        if (event.kind === AGENT_ACTIVITY_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            const attemptId = rowNullableString(command, "attempt_id");
            if (attemptId === null) {
                throw new SessionRuntimeError("session_conflict", "The ToolCall has no owning Attempt");
            }
            return { kind: "activity", attemptId, event, hotDetail: prepared.activityDetail?.payload ?? null };
        }
        if (event.kind === AGENT_CONTENT_KIND) {
            this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            return { kind: "content", event };
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
                return { kind: "unchanged" };
            }
            if (rowString(attempt, "state") === "indeterminate") {
                return {
                    kind: "request-interaction",
                    interactionId: event.interactionId,
                    turnId: rowString(command, "turn_id"),
                    attemptId,
                    request,
                    disposition: { kind: "cancel" },
                };
            }
            const interactionIds = [
                ...identifierArrayFromJson(rowString(attempt, "waiting_interaction_ids_json"), "waiting Interaction"),
                event.interactionId,
            ];
            return {
                kind: "request-interaction",
                interactionId: event.interactionId,
                turnId: rowString(command, "turn_id"),
                attemptId,
                request,
                disposition: { kind: "wait", interactionIds },
            };
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
                    return { kind: "unchanged" };
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
                return { kind: "unchanged" };
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
            const attemptId = rowString(interaction, "attempt_id");
            const remaining = this.#storage.listUnresolvedInteractionIds({
                scopeKey: key,
                sessionId: sessionId,
                attemptId: attemptId,
            });
            const remainingIds = remaining
                .map((row) => rowString(row, "interaction_id"))
                .filter((id) => id !== event.interactionId);
            return {
                kind: "resolve-interaction",
                interactionId: event.interactionId,
                attemptId,
                attemptState: remainingIds.length === 0 ? "running" : "waiting_input",
                interactionIds: remainingIds,
            };
        }
        if (event.kind === SESSION_COMPLETED_KIND) {
            const command = this.requireCommandState(key, sessionId, event.commandId, ["running", "indeterminate"]);
            return {
                kind: "complete",
                commandId: event.commandId,
                turnId: rowString(command, "turn_id"),
                state: event.stopReason === "cancelled" ? "cancelled" : "succeeded",
                stopReason: event.stopReason,
            };
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
                return {
                    kind: "fail",
                    commandId: rowString(command, "command_id"),
                    turnId: rowString(command, "turn_id"),
                    attemptSourceId,
                    dispatchAttempt: { attemptId: attemptSourceId, bindingId: rowString(command, "binding_id") },
                    code: event.code,
                    message: event.message,
                };
            }
            return {
                kind: "fail",
                commandId: rowString(command, "command_id"),
                turnId: rowString(command, "turn_id"),
                attemptSourceId,
                dispatchAttempt: null,
                code: event.code,
                message: event.message,
            };
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
            }
            return {
                kind: "configuration",
                bindingId: event.requestId,
                configRevision,
                configOptions: event.configOptions,
                binding:
                    existing === undefined
                        ? {
                              runtimeId: rowString(session, "runtime_id"),
                              agentRef: rowString(session, "agent_id"),
                              workspaceRef: rowString(session, "directory_id"),
                          }
                        : null,
            };
        }
        if (event.kind === SESSION_INFO_UPDATED_KIND) {
            return { kind: "title", title: event.title ?? "" };
        }
        return { kind: "unchanged" };
    };
}
