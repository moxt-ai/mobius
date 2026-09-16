import {
    AGENT_ACTIVITY_KIND,
    type CommandReceipt,
    type CommittedSessionEvent,
    decodeCommandReceipt,
    decodeRecordedSessionEvent,
    decodeSessionPromptCommand,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
    type CreateSessionBindingRequest,
    CreateSessionRequest,
    type ProjectScope,
    type SessionExport,
    SessionRuntimeError,
    type SessionSummary,
} from "../../entity/do/session.ts";
import type { ImportedInteraction, SessionImportPlan } from "../../entity/do/session-import.ts";
import type { SessionCommandGateway, SessionQueryGateway } from "../../gateway/index.ts";
import type { SessionDeletionStorage } from "../../storage/do/session-deletion-storage.ts";
import type { SessionTransferStorage } from "../../storage/do/session-transfer-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
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
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly storages: { readonly transfers: SessionTransferStorage; readonly deletions: SessionDeletionStorage };
        readonly services: {
            readonly archive: SessionArchiveService;
            readonly artifacts: SessionArtifactService;
            readonly state: SessionStateService;
        };
    }) {
        const { archive, artifacts, state: store } = cx.services;
        this.#archive = archive;
        this.#storage = cx.storages.transfers;
        this.#artifacts = artifacts;
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
            const payload =
                rowNullableString(row, "payload") ??
                this.#storage.readActiveEventPayload({
                    scopeKey: scopeKey(scope),
                    sessionId,
                    sequenceNumber: rowNumber(row, "sequence_number"),
                });
            if (payload === null || payload === undefined) {
                throw new SessionRuntimeError("session_storage_unavailable", "The active event payload is unavailable");
            }
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
            const terminalInteractions = interactions.map((interaction): ImportedInteraction => {
                const state = interaction.state;
                switch (state.kind) {
                    case "resolved":
                    case "expired":
                    case "cancelled":
                        return { ...interaction, state };
                    case "pending":
                    case "responded":
                        throw new SessionRuntimeError(
                            "invalid_export",
                            "An imported Interaction cannot schedule executable work",
                        );
                    default: {
                        const unreachable: never = state;
                        return unreachable;
                    }
                }
            });
            const plannedActivities = activities.map((activity): SessionImportPlan["activities"][number] => {
                const detail = activity.event.detail;
                const artifactId = detail.kind === "available" ? detail.artifactId : null;
                const artifact = artifactId === null ? undefined : artifacts.get(artifactId);
                if (artifactId === null || artifact === undefined) {
                    return { activity, artifact: null };
                }
                if (artifact.attemptId !== activity.attemptId || artifact.toolCallId !== activity.event.activityId) {
                    throw new SessionRuntimeError("invalid_export", "An export artifact belongs to another ToolCall");
                }
                return { activity, artifact: { artifactId, payload: artifact.payload } };
            });
            this.#storage.restoreImport({
                scopeKey: key,
                sessionId,
                nativeHistory,
                bindings,
                commands,
                interactions: terminalInteractions,
                activities: plannedActivities,
                events: events.map((event) => ({
                    event,
                    payloadHash: eventPayloadHashes.get(event.eventId) ?? "",
                    sourceId: event.source.kind === "attempt" ? event.source.attemptId : runtimeId,
                })),
                targetBindingId: targetBinding.bindingId,
                configRevision: targetBinding.configRevision,
                minimumSequence: minimumSequenceNumber,
                nextSequence: nextSequenceNumber,
                updatedAt: now,
            });
            signal.throwIfAborted();
        } catch (error) {
            if (created) {
                const cleanup = new AbortController();
                const deadline = setTimeout(
                    () => cleanup.abort(new DOMException("Import cleanup timed out", "TimeoutError")),
                    20_000,
                );
                try {
                    await this.#archive.deleteArchivedContent(scope, sessionId, cleanup.signal).catch(() => undefined);
                } finally {
                    clearTimeout(deadline);
                }
                this.#deletions.rollbackImport({ scopeKey: key, sessionId });
            }
            throw error;
        }
        return summaryFromRow(this.#store.requireActiveSessionRow(scope, sessionId, now));
    };
}
