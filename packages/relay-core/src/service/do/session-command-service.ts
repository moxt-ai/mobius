import {
    AGENT_MESSAGE_DELTA_KIND,
    type CommittedSessionEvent,
    decodeCommittedSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
    encodeCommittedSessionEvent,
    encodeSessionCancelCommand,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type Turn,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import {
    type CommittedEventResult,
    type CreateSessionBindingRequest,
    CreateSessionRequest,
    type ProjectScope,
    SessionRuntimeError,
    type SessionSummary,
    type TurnAcceptance,
    type TurnCancellationAcceptance,
} from "../../entity/do/session.ts";
import type { SessionCommandsStorage } from "../../storage/do/session-commands-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import { sha256 } from "./session-archive-codec.ts";
import type { SessionArchiveService } from "./session-archive-service.ts";
import type { SessionEventProjector } from "./session-event-projector.ts";
import type { SessionLifecycleService } from "./session-lifecycle-service.ts";
import {
    committedFromRow,
    DEFAULT_CONTENT_LIMIT_BYTES,
    DEFAULT_HOT_EVENT_LIMIT,
    DEFAULT_RETENTION_MILLISECONDS,
    eventCursor,
    pendingWorkFromRow,
    scopeKey,
    summaryFromRow,
    turnFromRow,
    validateDomainIdentifier,
    validateTimestamp,
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionCommandService {
    readonly #archive: SessionArchiveService;
    readonly #storage: SessionCommandsStorage;
    readonly #eventProjector: SessionEventProjector;
    readonly #lifecycle: SessionLifecycleService;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly storages: { readonly commands: SessionCommandsStorage };
        readonly services: {
            readonly archive: SessionArchiveService;
            readonly eventProjector: SessionEventProjector;
            readonly lifecycle: SessionLifecycleService;
            readonly state: SessionStateService;
        };
    }) {
        const { archive, eventProjector, lifecycle, state: store } = cx.services;
        this.#archive = archive;
        this.#storage = cx.storages.commands;
        this.#eventProjector = eventProjector;
        this.#lifecycle = lifecycle;
        this.#store = store;
    }

    readonly acceptTurn = async (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionPromptCommand,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        let validatedCommand: SessionPromptCommand;
        try {
            validatedCommand = decodeSessionPromptCommand(JSON.stringify(command));
        } catch (cause) {
            throw new SessionRuntimeError("session_conflict", "The session command is invalid", { cause });
        }
        if (this.#store.sessionRow(scope, validatedCommand.sessionId) === null) {
            await this.#lifecycle.createSession(
                scope,
                new CreateSessionRequest(
                    validatedCommand.sessionId,
                    runtimeId,
                    validatedCommand.agentId,
                    validatedCommand.bindingId,
                    validatedCommand.directoryId,
                    {
                        contentLimitBytes: DEFAULT_CONTENT_LIMIT_BYTES,
                        hotEventLimit: DEFAULT_HOT_EVENT_LIMIT,
                        idempotencyRetentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
                        level: "full",
                        retentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
                    },
                ),
                now,
                signal,
            );
        }
        const session = this.#store.requireActiveSessionRow(scope, validatedCommand.sessionId, now);
        if (rowString(session, "runtime_id") !== runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The session is bound to another runtime");
        }
        const key = scopeKey(scope);
        const encodedCommand = JSON.stringify(validatedCommand);
        const requestHash = await sha256(new TextEncoder().encode(encodedCommand));
        const binding = this.#storage.findMatchingBinding({
            scopeKey: key,
            sessionId: validatedCommand.sessionId,
            bindingId: validatedCommand.bindingId,
            runtimeId: runtimeId,
            agentRef: validatedCommand.agentId,
            workspaceRef: validatedCommand.directoryId,
        });
        if (binding === undefined) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Turn binding is not registered for this Session and Runtime",
            );
        }
        signal.throwIfAborted();
        const turnId = `turn_${crypto.randomUUID()}`;
        const workId = `dispatch_${turnId}`;
        const result = this.#storage.insertTurnWithDispatch({
            disposition: validatedCommand.disposition,
            targetCommandId: validatedCommand.targetCommandId,
            turn: {
                scopeKey: key,
                sessionId: validatedCommand.sessionId,
                commandId: validatedCommand.commandId,
                turnId: turnId,
                bindingId: validatedCommand.bindingId,
                idempotencyKey: validatedCommand.commandId,
                requestHash: requestHash,
                commandJson: encodedCommand,
                createdAt: now,
                updatedAt: now,
            },
            receipt: {
                scopeKey: key,
                sessionId: validatedCommand.sessionId,
                commandKind: validatedCommand.kind,
                idempotencyKey: validatedCommand.commandId,
                requestHash: requestHash,
                resultId: turnId,
                acceptedAt: now,
            },
            dispatch: {
                scopeKey: key,
                sessionId: validatedCommand.sessionId,
                workId: workId,
                runtimeId: runtimeId,
                deliveryPayload: encodedCommand,
                queuedAt: now,
            },
        });
        switch (result.kind) {
            case "existing": {
                if (rowString(result.turn, "request_hash") !== requestHash) {
                    throw new SessionRuntimeError(
                        "idempotency_conflict",
                        "The idempotency key was reused with different Turn input",
                    );
                }
                const state = rowString(result.turn, "state");
                if (
                    state !== "queued" &&
                    state !== "running" &&
                    state !== "succeeded" &&
                    state !== "failed" &&
                    state !== "cancelled" &&
                    state !== "indeterminate"
                ) {
                    throw new SessionRuntimeError("session_storage_unavailable", "The command state is invalid");
                }
                return {
                    kind: "duplicate",
                    pendingWork: result.pendingWork === null ? null : pendingWorkFromRow(result.pendingWork, scope),
                    state,
                    turn: turnFromRow(result.turn),
                };
            }
            case "busy":
                throw new SessionRuntimeError(
                    "session_busy",
                    validatedCommand.disposition === "reject"
                        ? "The session already has an active command"
                        : "The targeted active command is no longer available",
                );
            case "inserted":
                return {
                    kind: "accepted",
                    pendingWork: pendingWorkFromRow(result.pendingWork, scope),
                    turn: turnFromRow(result.turn),
                };
            default: {
                const unreachable: never = result;
                return unreachable;
            }
        }
    };

    readonly acceptTurnCancellation = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnCancellationAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(turnId, "turn");
        validateDomainIdentifier(idempotencyKey, "idempotency key");
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        const requestPayload = JSON.stringify({ sessionId, turnId });
        const requestHash = await sha256(new TextEncoder().encode(requestPayload));
        signal.throwIfAborted();
        const turnRow = this.#storage.findTurnRuntimeRecord({
            scopeKey: key,
            sessionId: sessionId,
            turnId: turnId,
        });
        if (turnRow === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
        }
        if (rowString(turnRow, "runtime_id") !== runtimeId) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Runtime does not own the Turn's immutable binding",
            );
        }
        const duplicate = this.#storage.findCancellationReceipt({
            scopeKey: key,
            sessionId: sessionId,
            commandKind: SESSION_CANCEL_KIND,
            idempotencyKey: idempotencyKey,
        });
        if (duplicate !== undefined) {
            if (rowString(duplicate, "request_hash") !== requestHash) {
                throw new SessionRuntimeError(
                    "idempotency_conflict",
                    "The idempotency key was reused for another Turn cancellation",
                );
            }
            const pending = this.#storage.findPendingWork(key, sessionId, rowString(duplicate, "result_id"));
            if (pending === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The accepted Turn cancellation is incomplete",
                );
            }
            return {
                duplicate: true,
                pendingWork: pendingWorkFromRow(pending, scope),
                turn: turnFromRow(turnRow),
            };
        }
        const state = rowString(turnRow, "state");
        if (state !== "queued" && state !== "running" && state !== "indeterminate") {
            throw new SessionRuntimeError("session_conflict", "The Turn no longer accepts cancellation");
        }
        const workId = `cancel_${crypto.randomUUID()}`;
        const deliveryPayload = encodeSessionCancelCommand({
            commandId: rowString(turnRow, "command_id"),
            kind: SESSION_CANCEL_KIND,
            sessionId,
        });
        const pending = this.#storage.insertCancellationWithDispatch({
            receipt: {
                scopeKey: key,
                sessionId: sessionId,
                commandKind: SESSION_CANCEL_KIND,
                idempotencyKey: idempotencyKey,
                requestHash: requestHash,
                resultId: workId,
                acceptedAt: now,
            },
            dispatch: {
                scopeKey: key,
                sessionId: sessionId,
                workId: workId,
                runtimeId: runtimeId,
                deliveryPayload: deliveryPayload,
                queuedAt: now,
            },
        });
        return {
            duplicate: false,
            pendingWork: pendingWorkFromRow(pending, scope),
            turn: turnFromRow(turnRow),
        };
    };

    readonly promoteQueuedTurnToSteering = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<Turn> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(turnId, "turn");
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        const turnRow = this.#storage.findTurnRuntimeRecord({
            scopeKey: key,
            sessionId,
            turnId,
        });
        if (turnRow === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
        }
        if (rowString(turnRow, "runtime_id") !== runtimeId) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Runtime does not own the Turn's immutable binding",
            );
        }
        let command: SessionPromptCommand;
        try {
            command = decodeSessionPromptCommand(rowString(turnRow, "command_json"));
        } catch (cause) {
            throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn request is invalid", {
                cause,
            });
        }
        if (command.disposition === SessionPromptDisposition.Steer) {
            return turnFromRow(turnRow);
        }
        if (rowString(turnRow, "state") !== "queued" || command.disposition !== SessionPromptDisposition.Queue) {
            throw new SessionRuntimeError("session_conflict", "Only a queued follow-up can be steered");
        }
        const active = this.#storage.findActiveTurn(key, sessionId);
        if (active === undefined || rowString(active, "command_id") !== command.targetCommandId) {
            throw new SessionRuntimeError("session_conflict", "The targeted active Turn is no longer available");
        }
        signal.throwIfAborted();
        return turnFromRow(
            this.#storage.promoteQueuedTurnToSteering({
                commandJson: encodeSessionPromptCommand({
                    ...command,
                    disposition: SessionPromptDisposition.Steer,
                }),
                scopeKey: key,
                sessionId,
                turnId,
                updatedAt: now,
            }),
        );
    };

    readonly commitEvent = async (
        scope: ProjectScope,
        runtimeId: string,
        envelope: SessionEventEnvelope,
        now: number,
        signal: AbortSignal,
    ): Promise<CommittedEventResult> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        let validatedEnvelope: SessionEventEnvelope;
        try {
            validatedEnvelope = decodeSessionEventEnvelope(encodeSessionEventEnvelope(envelope));
        } catch (cause) {
            throw new SessionRuntimeError("session_conflict", "The session event envelope is invalid", { cause });
        }
        const decoded = validateSessionEventEnvelope(validatedEnvelope);
        const session = this.#store.requireActiveSessionRow(scope, validatedEnvelope.sessionId, now);
        const key = scopeKey(scope);
        const sourceKind = validatedEnvelope.source.kind;
        if ("commandId" in decoded && sourceKind !== "attempt") {
            throw new SessionRuntimeError(
                "event_source_conflict",
                "An execution event requires an Attempt source identity",
            );
        }
        let owningRuntimeId: string;
        if (sourceKind === "attempt") {
            const ownership =
                decoded.kind === SESSION_STARTED_KIND || decoded.kind === SESSION_FAILED_KIND
                    ? this.#storage.findCommandRuntime(key, validatedEnvelope.sessionId, decoded.commandId)
                    : this.#storage.findAttemptRuntime(
                          key,
                          validatedEnvelope.sessionId,
                          validatedEnvelope.source.attemptId,
                      );
            if (ownership === undefined) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "The event references an unknown Attempt source",
                );
            }
            owningRuntimeId = rowString(ownership, "runtime_id");
        } else if ("commandId" in decoded) {
            const ownership = this.#storage.findCommandRuntime(key, validatedEnvelope.sessionId, decoded.commandId);
            owningRuntimeId =
                ownership === undefined ? rowString(session, "runtime_id") : rowString(ownership, "runtime_id");
        } else {
            owningRuntimeId = rowString(session, "runtime_id");
        }
        if (owningRuntimeId !== runtimeId) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Runtime does not own the event's immutable binding",
            );
        }
        const sourceId = sourceKind === "attempt" ? validatedEnvelope.source.attemptId : runtimeId;
        const sourceSeq = validatedEnvelope.source.sourceSeq;
        const payloadHash = await sha256(new TextEncoder().encode(validatedEnvelope.payload));
        if (sourceKind === "attempt") {
            if (decoded.kind === SESSION_STARTED_KIND && decoded.attemptId !== sourceId) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "The event source does not match the Attempt identity",
                );
            }
            if (decoded.kind !== SESSION_STARTED_KIND && "commandId" in decoded) {
                const command = this.#storage.findTurnAttempt(key, validatedEnvelope.sessionId, decoded.commandId);
                const existingAttemptId = command === undefined ? null : rowNullableString(command, "attempt_id");
                if (
                    command === undefined ||
                    (existingAttemptId === null
                        ? decoded.kind !== SESSION_FAILED_KIND || rowString(command, "state") !== "queued"
                        : existingAttemptId !== sourceId)
                ) {
                    throw new SessionRuntimeError(
                        "event_source_conflict",
                        "The event source does not own the referenced Turn",
                    );
                }
            }
        }
        const duplicate = this.#storage.findDuplicateEvent({
            scopeKey: key,
            sessionId: validatedEnvelope.sessionId,
            eventId: validatedEnvelope.eventId,
            sourceKind: sourceKind,
            sourceId: sourceId,
            sourceSeq: sourceSeq,
        });
        if (duplicate !== undefined) {
            if (
                rowString(duplicate, "event_id") !== validatedEnvelope.eventId ||
                rowString(duplicate, "payload_hash") !== payloadHash ||
                rowString(duplicate, "source_kind") !== sourceKind ||
                rowString(duplicate, "source_id") !== sourceId ||
                rowString(duplicate, "source_seq") !== sourceSeq
            ) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "A persisted event identity was reused with different content",
                );
            }
            const payload = await this.#archive.readEventPayload(scope, validatedEnvelope.sessionId, duplicate, signal);
            return {
                committed: committedFromRow(duplicate, scope, validatedEnvelope.sessionId, payload),
                duplicate: true,
            };
        }

        const prepared = this.#eventProjector.prepareEvent(session, validatedEnvelope, decoded);
        signal.throwIfAborted();
        const freshSession = this.#store.requireActiveSessionRow(scope, validatedEnvelope.sessionId, now);
        const previousSource = this.#storage.findLatestSourceSequence(
            key,
            validatedEnvelope.sessionId,
            sourceKind,
            sourceId,
        );
        const expectedSourceSeq =
            previousSource === undefined ? "1" : (BigInt(rowString(previousSource, "source_seq")) + 1n).toString();
        if (sourceSeq !== expectedSourceSeq) {
            throw new SessionRuntimeError("event_source_conflict", "The event source sequence is not contiguous");
        }
        this.#archive.assertArchiveCapacity(key, validatedEnvelope.sessionId, freshSession, prepared);
        const sequence = rowNumber(freshSession, "next_sequence");
        const projection = this.#eventProjector.planEventProjection(
            key,
            validatedEnvelope.sessionId,
            prepared,
            sourceKind === "attempt" ? sourceId : null,
        );
        const archiveSegmentId = `segment-${validatedEnvelope.eventId}`;
        const committed = this.#storage.commitEvent({
            scopeKey: key,
            sessionId: validatedEnvelope.sessionId,
            sequenceNumber: sequence,
            eventId: validatedEnvelope.eventId,
            payloadHash: payloadHash,
            sourceKind: sourceKind,
            sourceId: sourceId,
            sourceSeq: sourceSeq,
            messageId: prepared.event.kind === AGENT_MESSAGE_DELTA_KIND ? prepared.event.messageId : "",
            payload: prepared.payload,
            archiveSegmentId: archiveSegmentId,
            recordedAt: now,
            expectedPreviousSourceSequence:
                previousSource === undefined ? null : rowString(previousSource, "source_seq"),
            projection,
            activityDetail: prepared.activityDetail,
        });
        if (!committed) {
            throw new SessionRuntimeError("event_source_conflict", "The session event sequence changed during commit");
        }
        const result: CommittedSessionEvent = {
            cursor: eventCursor(scope, validatedEnvelope.sessionId, sequence),
            eventId: validatedEnvelope.eventId,
            kind: SESSION_EVENT_COMMITTED_KIND,
            payload: prepared.payload,
            recordedAt: new Date(now).toISOString(),
            sequence: sequence.toString(),
            sessionId: validatedEnvelope.sessionId,
            source: validatedEnvelope.source,
        };
        signal.throwIfAborted();
        return {
            committed: decodeCommittedSessionEvent(encodeCommittedSessionEvent(result)),
            duplicate: false,
        };
    };

    readonly setDefaultBinding = async (
        scope: ProjectScope,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(binding.bindingId, "binding");
        validateDomainIdentifier(binding.runtimeId, "runtime");
        validateDomainIdentifier(binding.agentRef, "agent");
        validateDomainIdentifier(binding.workspaceRef, "workspace");
        if (!Number.isSafeInteger(binding.configRevision) || binding.configRevision < 0) {
            throw new SessionRuntimeError("session_conflict", "The binding configuration revision is invalid");
        }
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        const existing = this.#storage.findBinding(key, sessionId, binding.bindingId);
        const changed =
            existing !== undefined &&
            (rowString(existing, "runtime_id") !== binding.runtimeId ||
                rowString(existing, "agent_ref") !== binding.agentRef ||
                rowString(existing, "workspace_ref") !== binding.workspaceRef ||
                rowNumber(existing, "config_revision") !== binding.configRevision);
        if (changed) {
            const used = this.#storage.findBindingTurn(key, sessionId, binding.bindingId);
            if (used !== undefined) {
                throw new SessionRuntimeError("session_conflict", "A used Session binding is immutable");
            }
        }
        this.#storage.writeDefaultBinding({
            kind: existing === undefined ? "insert" : changed ? "replace" : "select",
            updatedAt: now,
            binding: {
                bindingId: binding.bindingId,
                runtimeId: binding.runtimeId,
                agentRef: binding.agentRef,
                workspaceRef: binding.workspaceRef,
                configRevision: binding.configRevision,
                createdAt: existing === undefined || changed ? now : rowNumber(existing, "created_at"),
                scopeKey: key,
                sessionId: sessionId,
            },
        });
        signal.throwIfAborted();
        return summaryFromRow(this.#store.requireSessionRow(scope, sessionId, true));
    };

    readonly markRuntimeDisconnected = async (
        scope: ProjectScope,
        runtimeId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly CommittedSessionEvent[]> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        const key = scopeKey(scope);
        this.#storage.recordRuntimeDisconnection({ scopeKey: key, runtimeId, updatedAt: now });
        return [];
    };
}
