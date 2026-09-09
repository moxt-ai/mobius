import {
    type Attempt,
    decodeInteractionResponse,
    type InteractionResponse,
    type PendingWork,
} from "@moxt-ai/mobius-protocol";
import {
    type InteractionResponseAcceptance,
    type PendingDaemonDelivery,
    type ProjectScope,
    SessionRuntimeError,
} from "../../entity/do/session.ts";
import type { SessionInteractionsStorage } from "../../storage/do/session-interactions-storage.ts";
import { rowNullableString, rowString } from "../../storage/do/sqlite-row.ts";
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
    readonly #queries: SessionQueryService;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly storages: { readonly interactions: SessionInteractionsStorage };
        readonly services: { readonly queries: SessionQueryService; readonly state: SessionStateService };
    }) {
        const { queries, state: store } = cx.services;
        this.#storage = cx.storages.interactions;
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
        const result = this.#storage.writeInteractionResponse({
            responseJson: encodedResponse,
            responderId: responderId,
            respondedAt: now,
            scopeKey: key,
            sessionId: sessionId,
            interactionId: interactionId,
            workId: workId,
            runtimeId: rowString(interaction, "runtime_id"),
            deliveryPayload: deliveryPayload,
        });
        if (result === null) {
            throw new SessionRuntimeError("interaction_conflict", "The Interaction no longer accepts a response");
        }
        return {
            duplicate: false,
            interaction: interactionFromRow(result.interaction),
            pendingWork: pendingWorkFromRow(result.pendingWork, scope),
        };
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
        const work = this.#storage.findPendingWork(key, sessionId, workId);
        if (work === undefined) {
            throw new SessionRuntimeError("pending_work_not_found", "The PendingWork item does not exist");
        }
        const state = rowString(work, "state");
        if (state === "completed") {
            return pendingWorkFromRow(work, scope);
        }
        if (state === "failed") {
            throw new SessionRuntimeError("session_conflict", "The failed PendingWork item cannot complete");
        }
        const updated = this.#storage.writePendingWorkCompletion({
            completedAt: now,
            scopeKey: key,
            sessionId: sessionId,
            workId: workId,
            expectedState: state,
        });
        if (updated === null) {
            throw new SessionRuntimeError("session_storage_unavailable", "The completed PendingWork item disappeared");
        }
        return pendingWorkFromRow(updated, scope);
    };

    readonly reconcileAttempt = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        attemptId: string,
        outcome: import("../../entity/do/session.ts").AttemptReconciliationOutcome,
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
        const attempt = this.#storage.findRuntimeAttempt(key, sessionId, attemptId, runtimeId);
        if (attempt === undefined) {
            throw new SessionRuntimeError("session_conflict", "Only the owning Runtime can reconcile an Attempt");
        }
        const attemptState = rowString(attempt, "state");
        const duplicate =
            outcome.kind === "running" && (attemptState === "running" || attemptState === "waiting_input");
        if (!duplicate && attemptState !== "indeterminate") {
            throw new SessionRuntimeError(
                "session_conflict",
                "The Attempt cannot be reconciled from its current state",
            );
        }
        if (
            !duplicate &&
            !this.#storage.writeAttemptReconciliation({
                scopeKey: key,
                sessionId,
                runtimeId,
                attemptId,
                expectedState: attemptState,
                outcome,
                updatedAt: now,
            })
        ) {
            throw new SessionRuntimeError("session_conflict", "The Attempt changed during reconciliation");
        }
        signal.throwIfAborted();
        return await this.#queries.readAttempt(scope, sessionId, attemptId, signal);
    };
}
