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
import type { SessionCommandGateway, SessionQueryGateway } from "../../gateway/index.ts";
import type { SessionDeletionStorage } from "../../storage/session/session-deletion-storage.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import type { SessionTransferStorage } from "../../storage/session/session-transfer-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/session/sqlite-row.ts";
import {
    type CreateSessionBindingRequest,
    CreateSessionRequest,
    type ProjectScope,
    type SessionExport,
    SessionRuntimeError,
    type SessionSummary,
} from "./session.ts";
import { encodeBase64, sha256 } from "./session-archive-codec.ts";
import type { SessionArchiveService } from "./session-archive-service.ts";
import type { SessionArtifactService } from "./session-artifact-service.ts";
import { decodeSessionImport } from "./session-export-codec.ts";
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
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionTransferService {
    readonly #archive: SessionArchiveService;
    readonly #storage: SessionTransferStorage;
    readonly #deletions: SessionDeletionStorage;
    readonly #artifacts: SessionArtifactService;
    readonly #database: SessionSqlDatabase;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly gateways: { readonly database: SessionSqlDatabase };
        readonly storages: { readonly transfers: SessionTransferStorage; readonly deletions: SessionDeletionStorage };
        readonly services: {
            readonly archive: SessionArchiveService;
            readonly artifacts: SessionArtifactService;
            readonly state: SessionStateService;
        };
    }) {
        const { database } = cx.gateways;
        const { archive, artifacts, state: store } = cx.services;
        this.#archive = archive;
        this.#storage = cx.storages.transfers;
        this.#artifacts = artifacts;
        this.#database = database;
        this.#deletions = cx.storages.deletions;
        this.#store = store;
    }

    readonly exportSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
        readNativeHistory: SessionQueryGateway["readNativeHistory"],
    ): Promise<SessionExport> => {
        signal.throwIfAborted();
        const sessionRow = this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const session = summaryFromRow(sessionRow);
        const eventRows = this.#storage.listEvents({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        const events: CommittedSessionEvent[] = [];
        let exportBytes = 0;
        for (const row of eventRows) {
            const payload = await this.#archive.readEventPayload(scope, sessionId, row, signal);
            exportBytes += new TextEncoder().encode(payload).byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
            }
            events.push(committedFromRow(row, scope, sessionId, payload));
        }
        const commandRows = this.#storage.listTurns({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        const turns: SessionExport["turns"][number][] = commandRows.map((row) => {
            const encodedCommand = rowString(row, "command_json");
            const response = rowString(row, "response");
            exportBytes += new TextEncoder().encode(`${encodedCommand}${response}`).byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
            }
            let command: SessionPromptCommand;
            try {
                command = decodeSessionPromptCommand(encodedCommand);
            } catch (cause) {
                throw new SessionRuntimeError("session_storage_unavailable", "A stored session command is invalid", {
                    cause,
                });
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
        const activityRows = this.#storage.listActivities({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        const toolCallViews: SessionExport["toolCallViews"][number][] = activityRows.map((row) => {
            const encodedSummary = rowString(row, "summary_json");
            exportBytes += new TextEncoder().encode(encodedSummary).byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
            }
            const event = decodeRecordedSessionEvent(encodedSummary);
            if (event.kind !== AGENT_ACTIVITY_KIND) {
                throw new SessionRuntimeError("session_storage_unavailable", "A stored session activity is invalid");
            }
            return {
                attemptId: rowString(row, "attempt_id"),
                event,
                eventSequence: rowNumber(row, "event_sequence").toString(),
            };
        });
        const artifactRows = this.#storage.listActivityArtifacts({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
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
            const encoded = hot ?? (await this.#archive.readArtifact(scope, sessionId, artifactId, signal));
            const bytes = new TextEncoder().encode(encoded);
            exportBytes += bytes.byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
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
        const uploadedArtifacts = await this.#artifacts.exportAvailable(scope, sessionId, signal);
        for (const artifact of uploadedArtifacts) {
            exportBytes += artifact.byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
            }
        }
        const bindings = this.#storage
            .listBindings({ scopeKey: scopeKey(scope), sessionId: sessionId })
            .map(bindingFromRow);
        const commandReceipts: CommandReceipt[] = this.#storage
            .listCommandReceipts({ scopeKey: scopeKey(scope), sessionId: sessionId })
            .map((row) => {
                const acceptedAt = rowNumber(row, "accepted_at");
                return decodeCommandReceipt({
                    acceptedAt: new Date(acceptedAt).toISOString(),
                    commandKind: rowString(row, "command_kind"),
                    expiresAt: new Date(
                        acceptedAt + rowNumber(sessionRow, "idempotency_retention_milliseconds"),
                    ).toISOString(),
                    idempotencyKey: rowString(row, "idempotency_key"),
                    projectId: scope.projectId,
                    requestHash: rowString(row, "request_hash"),
                    resultId: rowString(row, "result_id"),
                    sessionId,
                    tenantId: scope.tenantId,
                });
            });
        const interactions = this.#storage
            .listInteractions({ scopeKey: scopeKey(scope), sessionId: sessionId })
            .map(interactionFromRow);
        const nativeHistory = await readNativeHistory(scope, sessionId, signal);
        if (nativeHistory !== null) {
            exportBytes += new TextEncoder().encode(JSON.stringify(nativeHistory)).byteLength;
            if (exportBytes > MAX_EXPORT_BYTE_LENGTH) {
                throw new SessionRuntimeError("content_too_large", "The session export exceeds the configured limit");
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
            uploadedArtifacts,
        };
    };

    readonly importSession = async (
        scope: ProjectScope,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
        createSession: SessionCommandGateway["createSession"],
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        const {
            activities,
            artifacts,
            bindings,
            commands,
            contentLimitBytes,
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
            uploadedArtifacts,
        } = await decodeSessionImport(exported, signal);
        if (bindings.some((binding) => binding.bindingId === targetBinding.bindingId)) {
            throw new SessionRuntimeError(
                "session_conflict",
                "The destination Session binding identifier is already in the export",
            );
        }
        if (this.#store.sessionRow(scope, sessionId) !== null) {
            throw new SessionRuntimeError("session_conflict", "The imported session identifier is already in use");
        }
        const key = scopeKey(scope);
        let created = false;
        try {
            await createSession(
                scope,
                new CreateSessionRequest(
                    sessionId,
                    targetBinding.runtimeId,
                    targetBinding.agentRef,
                    targetBinding.bindingId,
                    targetBinding.workspaceRef,
                    {
                        contentLimitBytes,
                        hotEventLimit,
                        idempotencyRetentionMilliseconds,
                        level,
                        retentionMilliseconds,
                    },
                    title,
                    "session-import",
                ),
                now,
                signal,
            );
            created = true;
            signal.throwIfAborted();
            for (const artifact of uploadedArtifacts) {
                await this.#artifacts.restoreAvailable(scope, sessionId, artifact, now, signal);
            }
            this.#database.transaction(() => {
                if (nativeHistory !== null) {
                    this.#storage.updateNativeHistory({
                        nativeHistoryJson: JSON.stringify(nativeHistory),
                        scopeKey: key,
                        sessionId: sessionId,
                    });
                }
                for (const binding of bindings) {
                    this.#storage.insertBinding({
                        scopeKey: key,
                        sessionId: sessionId,
                        bindingId: binding.bindingId,
                        runtimeId: binding.runtimeId,
                        agentRef: binding.agentRef,
                        workspaceRef: binding.workspaceRef,
                        configRevision: binding.configRevision,
                        createdAt: Date.parse(binding.createdAt),
                    });
                }
                for (const command of commands) {
                    this.#storage.insertTurn({
                        scopeKey: key,
                        sessionId: sessionId,
                        commandId: command.command.commandId,
                        turnId: command.turnId,
                        bindingId: command.bindingId,
                        idempotencyKey: command.idempotencyKey,
                        requestHash: command.requestHash,
                        commandJson: JSON.stringify(command.command),
                        state: command.state,
                        response: command.response,
                        attemptId: command.attemptId,
                        startedAt: command.startedAt,
                        completedAt: command.completedAt,
                        stopReason: command.stopReason,
                        errorCode: command.errorCode,
                        errorMessage: command.errorMessage,
                        createdAt: command.createdAt,
                        updatedAt: command.updatedAt,
                    });
                    this.#storage.insertCommandReceipt({
                        scopeKey: key,
                        sessionId: sessionId,
                        commandKind: command.command.kind,
                        idempotencyKey: command.idempotencyKey,
                        requestHash: command.requestHash,
                        resultId: command.turnId,
                        acceptedAt: command.createdAt,
                    });
                    if (command.attemptId !== null && command.startedAt !== null) {
                        this.#storage.insertAttempt({
                            scopeKey: key,
                            sessionId: sessionId,
                            attemptId: command.attemptId,
                            turnId: command.turnId,
                            bindingId: command.bindingId,
                            state: command.state,
                            startedAt: command.startedAt,
                            completedAt: command.completedAt,
                            stopReason: command.stopReason,
                            errorCode: command.errorCode,
                            errorMessage: command.errorMessage,
                            updatedAt: command.updatedAt,
                        });
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
                                responseJson = JSON.stringify(interaction.state.resolution.response);
                                responderId = interaction.state.resolution.responderId;
                                respondedAt = Date.parse(interaction.state.resolution.respondedAt);
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
                    this.#storage.insertInteraction({
                        scopeKey: key,
                        sessionId: sessionId,
                        interactionId: interaction.interactionId,
                        turnId: interaction.turnId,
                        attemptId: interaction.attemptId,
                        requestJson: JSON.stringify(interaction.request),
                        state: interaction.state.kind,
                        responseJson: responseJson,
                        responderId: responderId,
                        respondedAt: respondedAt,
                        resolvedAt: resolvedAt,
                    });
                }
                for (const activity of activities) {
                    const detail = activity.event.detail;
                    const artifactId = detail.kind === "available" ? detail.artifactId : null;
                    const artifact = artifactId === null ? undefined : artifacts.get(artifactId);
                    this.#storage.insertActivity({
                        scopeKey: key,
                        sessionId: sessionId,
                        commandId: activity.event.commandId,
                        attemptId: activity.attemptId,
                        activityId: activity.event.activityId,
                        summaryJson: encodeAgentActivityEvent(activity.event),
                        detailKind: detail.kind,
                        detailArtifactId: artifactId,
                        hotDetail: artifact?.payload ?? null,
                        capturedBytes: detail.kind === "truncated" ? detail.capturedBytes : 0,
                        originalBytes: detail.kind === "truncated" ? detail.originalBytes : 0,
                        eventSequence: activity.eventSequence,
                    });
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
                    this.#storage.insertEvent({
                        scopeKey: key,
                        sessionId: sessionId,
                        sequenceNumber: Number(committed.sequence),
                        eventId: committed.eventId,
                        payloadHash: eventPayloadHashes.get(committed.eventId) ?? "",
                        sourceKind: committed.source.kind,
                        sourceId: committed.source.kind === "attempt" ? committed.source.attemptId : runtimeId,
                        sourceSeq: committed.source.sourceSeq,
                        payload: committed.payload,
                        archiveSegmentId: archiveSegmentId,
                        recordedAt: Date.parse(committed.recordedAt),
                    });
                }
                this.#storage.restoreSessionConfiguration({
                    configRevision: targetBinding.configRevision,
                    minimumSequence: minimumSequenceNumber,
                    nextSequence: nextSequenceNumber,
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                });
                this.#storage.restoreBindingRevision({
                    configRevision: targetBinding.configRevision,
                    scopeKey: key,
                    sessionId: sessionId,
                    bindingId: targetBinding.bindingId,
                });
            });
            signal.throwIfAborted();
        } catch (error) {
            if (created) {
                await this.#archive
                    .deleteArchivedContent(scope, sessionId, AbortSignal.timeout(20_000))
                    .catch(() => undefined);
                this.#database.transaction(() => {
                    this.#deletions.deleteUploadedArtifacts({ scopeKey: key, sessionId });
                    this.#deletions.deleteArchiveWork({ scopeKey: key, sessionId });
                    this.#deletions.deleteArchiveSegments({ scopeKey: key, sessionId });
                    this.#deletions.deleteArtifacts({ scopeKey: key, sessionId });
                    this.#deletions.deleteToolCallViews({ scopeKey: key, sessionId });
                    this.#deletions.deletePendingWork({ scopeKey: key, sessionId });
                    this.#deletions.deleteInteractions({ scopeKey: key, sessionId });
                    this.#deletions.deleteSessionEvents({ scopeKey: key, sessionId });
                    this.#deletions.deleteAttempts({ scopeKey: key, sessionId });
                    this.#deletions.deleteCommandReceipts({ scopeKey: key, sessionId });
                    this.#deletions.deleteTurns({ scopeKey: key, sessionId });
                    this.#deletions.deleteSessionBindings({ scopeKey: key, sessionId });
                    this.#deletions.deleteSessions({ scopeKey: key, sessionId });
                });
            }
            throw error;
        }
        return summaryFromRow(this.#store.requireActiveSessionRow(scope, sessionId, now));
    };
}
