import {
    type Attempt,
    decodeInteractionResponse,
    type InteractionResponse,
    type PendingWork,
} from "@moxt-ai/mobius-protocol";
import type { SessionInteractionsStorage } from "../../storage/session/session-interactions-storage.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import { rowNullableString, rowString } from "../../storage/session/sqlite-row.ts";
import {
    type InteractionResponseAcceptance,
    type PendingDaemonDelivery,
    type ProjectScope,
    SessionRuntimeError,
} from "./session.ts";
import { sha256 } from "./session-archive-codec.ts";
import type { SessionQueryService } from "./session-query-service.ts";
import {
    interactionFromRow,
    pendingWorkFromRow,
    scopeKey,
    validateDomainIdentifier,
    validateLimit,
    validateTimestamp,
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionInteractionService {
    readonly #storage: SessionInteractionsStorage;
    readonly #database: SessionSqlDatabase;
    readonly #queries: SessionQueryService;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly gateways: { readonly database: SessionSqlDatabase };
        readonly storages: { readonly interactions: SessionInteractionsStorage };
        readonly services: { readonly queries: SessionQueryService; readonly state: SessionStateService };
    }) {
        const { database } = cx.gateways;
        const { queries, state: store } = cx.services;
        this.#storage = cx.storages.interactions;
        this.#database = database;
        this.#queries = queries;
        this.#store = store;
    }
    readonly acceptInteractionResponse = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        responderId: string,
        response: InteractionResponse,
        deliveryPayload: string,
        now: number,
        signal: AbortSignal,
    ): Promise<InteractionResponseAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(interactionId, "interaction");
        validateDomainIdentifier(responderId, "responder");
        if (deliveryPayload.length === 0 || new TextEncoder().encode(deliveryPayload).byteLength > 8 * 1024 * 1024) {
            throw new SessionRuntimeError(
                "interaction_conflict",
                "The Interaction response delivery payload is invalid",
            );
        }
        let validatedResponse: InteractionResponse;
        try {
            validatedResponse = decodeInteractionResponse(response);
        } catch (cause) {
            throw new SessionRuntimeError("interaction_conflict", "The Interaction response is invalid", { cause });
        }
        const key = scopeKey(scope);
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const encodedResponse = JSON.stringify(validatedResponse);
        const workDigest = await sha256(new TextEncoder().encode(`${key}\u0000${sessionId}\u0000${interactionId}`));
        const workId = `work_${workDigest.slice(0, 32)}`;
        signal.throwIfAborted();
        return this.#database.transaction(() => {
            const interaction = this.#storage.findInteractionRuntime(key, sessionId, interactionId);
            if (interaction === undefined) {
                throw new SessionRuntimeError("interaction_not_found", "The Interaction does not exist");
            }
            if (interactionFromRow(interaction).request.kind !== validatedResponse.kind) {
                throw new SessionRuntimeError(
                    "interaction_conflict",
                    "The response kind does not match the Interaction request",
                );
            }
            const state = rowString(interaction, "state");
            if (state === "responded") {
                const work = this.#storage.findInteractionDelivery(key, sessionId, interactionId);
                if (
                    rowNullableString(interaction, "response_json") !== encodedResponse ||
                    rowNullableString(interaction, "responder_id") !== responderId ||
                    work === undefined ||
                    rowNullableString(work, "delivery_payload") !== deliveryPayload
                ) {
                    throw new SessionRuntimeError(
                        "interaction_conflict",
                        "The Interaction response identity was reused with different input",
                    );
                }
                return {
                    duplicate: true,
                    interaction: interactionFromRow(interaction),
                    pendingWork: pendingWorkFromRow(work, scope),
                };
            }
            if (state !== "pending") {
                throw new SessionRuntimeError("interaction_conflict", "The Interaction no longer accepts a response");
            }
            this.#storage.recordInteractionResponse({
                responseJson: encodedResponse,
                responderId: responderId,
                respondedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                interactionId: interactionId,
            });
            this.#storage.insertInteractionDelivery({
                scopeKey: key,
                sessionId: sessionId,
                workId: workId,
                runtimeId: rowString(interaction, "runtime_id"),
                interactionId: interactionId,
                deliveryPayload: deliveryPayload,
                queuedAt: now,
            });
            const updatedInteraction = this.#storage.findInteraction(key, sessionId, interactionId);
            const pendingWork = this.#storage.findPendingWork(key, sessionId, workId);
            if (updatedInteraction === undefined || pendingWork === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The Interaction response was not persisted atomically",
                );
            }
            return {
                duplicate: false,
                interaction: interactionFromRow(updatedInteraction),
                pendingWork: pendingWorkFromRow(pendingWork, scope),
            };
        });
    };

    readonly listPendingDaemonDeliveries = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly PendingDaemonDelivery[]> => {
        signal.throwIfAborted();
        scopeKey(scope);
        validateDomainIdentifier(runtimeId, "runtime");
        validateLimit(limit);
        return this.#storage
            .listDaemonDeliveries({
                scopeKey: scopeKey(scope),
                runtimeId: runtimeId,
                limit: limit,
            })
            .map((row) => {
                const workKind = rowString(row, "work_kind");
                const interactionId = rowNullableString(row, "interaction_id");
                const payload = rowNullableString(row, "delivery_payload");
                if (payload === null || (workKind === "interaction_response" && interactionId === null)) {
                    throw new SessionRuntimeError(
                        "session_storage_unavailable",
                        "The pending daemon delivery is incomplete",
                    );
                }
                return {
                    interactionId,
                    payload,
                    pendingWork: pendingWorkFromRow(row, scope),
                };
            });
    };

    readonly markPendingWorkCompleted = async (
        scope: ProjectScope,
        sessionId: string,
        workId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<PendingWork> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(workId, "pending work");
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        return this.#database.transaction(() => {
            const work = this.#storage.findPendingWork(key, sessionId, workId);
            if (work === undefined) {
                throw new SessionRuntimeError("pending_work_not_found", "The PendingWork item does not exist");
            }
            const state = rowString(work, "state");
            if (state !== "completed") {
                if (state === "failed") {
                    throw new SessionRuntimeError("session_conflict", "The failed PendingWork item cannot complete");
                }
                this.#storage.completePendingWork({
                    completedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    workId: workId,
                });
            }
            const updated = this.#storage.findPendingWork(key, sessionId, workId);
            if (updated === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The completed PendingWork item disappeared",
                );
            }
            return pendingWorkFromRow(updated, scope);
        });
    };

    readonly reconcileAttempt = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        attemptId: string,
        outcome: import("./session.ts").AttemptReconciliationOutcome,
        now: number,
        signal: AbortSignal,
    ): Promise<Attempt> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(attemptId, "attempt");
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        this.#database.transaction(() => {
            const attempt = this.#storage.findRuntimeAttempt(key, sessionId, attemptId, runtimeId);
            if (attempt === undefined) {
                throw new SessionRuntimeError("session_conflict", "Only the owning Runtime can reconcile an Attempt");
            }
            const attemptState = rowString(attempt, "state");
            if (outcome.kind === "running" && (attemptState === "running" || attemptState === "waiting_input")) {
                return;
            }
            if (attemptState !== "indeterminate") {
                throw new SessionRuntimeError(
                    "session_conflict",
                    "The Attempt cannot be reconciled from its current state",
                );
            }
            const turnId = rowString(attempt, "turn_id");
            if (outcome.kind === "running") {
                this.#storage.resumeAttempt({
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    attemptId: attemptId,
                });
                this.#storage.resumeTurn({
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    turnId: turnId,
                });
                return;
            }
            if (outcome.kind === "succeeded") {
                this.#storage.succeedAttempt({
                    completedAt: now,
                    stopReason: outcome.stopReason,
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    attemptId: attemptId,
                });
                this.#storage.succeedTurn({
                    completedAt: now,
                    stopReason: outcome.stopReason,
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    turnId: turnId,
                });
                return;
            }
            if (outcome.kind === "cancelled") {
                this.#storage.cancelAttempt({
                    completedAt: now,
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    attemptId: attemptId,
                });
                this.#storage.cancelTurn({
                    completedAt: now,
                    updatedAt: now,
                    scopeKey: key,
                    sessionId: sessionId,
                    turnId: turnId,
                });
                return;
            }
            this.#storage.failAttempt({
                completedAt: now,
                errorCode: outcome.error.code,
                errorMessage: outcome.error.message,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                attemptId: attemptId,
            });
            this.#storage.failTurn({
                completedAt: now,
                errorCode: outcome.error.code,
                errorMessage: outcome.error.message,
                updatedAt: now,
                scopeKey: key,
                sessionId: sessionId,
                turnId: turnId,
            });
        });
        signal.throwIfAborted();
        return await this.#queries.readAttempt(scope, sessionId, attemptId, signal);
    };
}
