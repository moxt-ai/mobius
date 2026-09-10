import {
    BOT_SESSION_PROMPT_KIND,
    type BotCompletionDeliveryPolicy,
    BotConnectionReplyRoute,
    type BotDeliveryTargetReference,
    type BotReplyRoute,
    BotSessionPromptCommand,
    decodeBotSessionPromptCommand,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    encodeBotSessionPromptCommand,
    encodeSessionPromptCommand,
    NoBotCompletionDeliveryPolicy,
    OwnerBotReplyRoute,
    RequiredBotCompletionDeliveryPolicy,
    SESSION_PROMPT_KIND,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { ExecutionPermit } from "../../entity/authentication/project-authentication.ts";
import {
    BOT_EXECUTION_LIFETIME_MILLISECONDS,
    BOT_EXECUTION_OUTBOUND_USAGE_LIMIT,
    BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS,
    BotConversationEvent,
    BotConversationEventPage,
    BotExecutionRecord,
    BotOutboundAcceptance,
    type BotOutboundSubmission,
    type BotSessionProvisioning,
    BotSessionRuntimeError,
    BotTurnAcceptance,
    type BotTurnSubmission,
    PendingBotOutbound,
} from "../../entity/bot/bot-session.ts";
import { CreateSessionRequest, type ProjectScope, SessionRecordingPolicy } from "../../entity/do/session.ts";
import { createRandomToken, hashSecret } from "../../entity/pairing/pairing.ts";
import type { SessionCommandGateway } from "../../gateway/session-command-gateway.ts";
import type { SessionQueryGateway } from "../../gateway/session-query-gateway.ts";
import type { DoSqlRow } from "../../infra/do-sql-database.ts";
import type { BotSessionStorage } from "../../storage/do/bot-session-storage.ts";
import { sha256 } from "./session-archive-codec.ts";
import {
    DEFAULT_CONTENT_LIMIT_BYTES,
    DEFAULT_HOT_EVENT_LIMIT,
    DEFAULT_RETENTION_MILLISECONDS,
    scopeKey,
    validateDomainIdentifier,
    validateTimestamp,
} from "./session-records.ts";

const MAX_OUTBOUND_MESSAGE_LENGTH = 10_000;
const MAX_ACTOR_REFERENCE_LENGTH = 500;
const MAX_PENDING_OUTBOUND_BATCH = 100;

interface BotBackingSessionRuntime {
    readonly createSession: SessionCommandGateway["createSession"];
    readonly readEvents: SessionQueryGateway["readEvents"];
    readonly readSession: SessionQueryGateway["readSession"];
}

interface BotSessionContext {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargets: readonly BotDeliveryTargetReference[];
    readonly behaviorDigest: string;
    readonly behaviorInstructions: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: BotCompletionDeliveryPolicy;
    readonly conversationId: string;
    readonly localGrantId: string;
    readonly replyRoute: BotReplyRoute;
    readonly runtimeId: string;
    readonly workspaceRef: string;
}

class BotSessionContextRecord implements BotSessionContext {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargets: readonly BotDeliveryTargetReference[];
    readonly behaviorDigest: string;
    readonly behaviorInstructions: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: BotCompletionDeliveryPolicy = new NoBotCompletionDeliveryPolicy();
    readonly conversationId: string;
    readonly localGrantId: string;
    readonly replyRoute: BotReplyRoute = new OwnerBotReplyRoute();
    readonly runtimeId: string;
    readonly workspaceRef: string;

    constructor(row: DoSqlRow) {
        this.agentConfigRevision = rowInteger(row, "agent_config_revision");
        this.agentRef = rowText(row, "agent_ref");
        this.allowedDeliveryTargets = decodeTargets(rowText(row, "allowed_delivery_targets_json"));
        this.behaviorDigest = rowText(row, "behavior_digest");
        this.behaviorInstructions = rowText(row, "behavior_instructions", true);
        this.behaviorRevisionId = rowText(row, "behavior_revision_id");
        this.bindingId = rowText(row, "binding_id");
        this.bindingRevision = rowInteger(row, "binding_revision");
        this.botId = rowText(row, "bot_id");
        this.conversationId = rowText(row, "conversation_id");
        this.localGrantId = rowText(row, "local_grant_id");
        this.runtimeId = rowText(row, "runtime_id");
        this.workspaceRef = rowText(row, "workspace_ref");
    }
}

class RequiredCompletionBotSessionContext extends BotSessionContextRecord {
    override readonly completionPolicy: RequiredBotCompletionDeliveryPolicy;

    constructor(row: DoSqlRow, completionPolicy: RequiredBotCompletionDeliveryPolicy) {
        super(row);
        this.completionPolicy = completionPolicy;
    }
}

class ConnectedBotSessionContext extends BotSessionContextRecord {
    override readonly replyRoute: BotConnectionReplyRoute;

    constructor(row: DoSqlRow, replyRoute: BotConnectionReplyRoute) {
        super(row);
        this.replyRoute = replyRoute;
    }
}

class ConnectedRequiredBotSessionContext extends RequiredCompletionBotSessionContext {
    override readonly replyRoute: BotConnectionReplyRoute;

    constructor(
        row: DoSqlRow,
        completionPolicy: RequiredBotCompletionDeliveryPolicy,
        replyRoute: BotConnectionReplyRoute,
    ) {
        super(row, completionPolicy);
        this.replyRoute = replyRoute;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function rowText(row: DoSqlRow, key: string, allowEmpty = false): string {
    const value = row[key];
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot session record is invalid");
    }
    return value;
}

function rowInteger(row: DoSqlRow, key: string): number {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot session record is invalid");
    }
    return value;
}

function parseObject(encoded: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot session record is invalid", {
            cause,
        });
    }
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot session record is invalid");
    }
    return value;
}

function decodeTargets(encoded: string): readonly BotDeliveryTargetReference[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot delivery targets are invalid", {
            cause,
        });
    }
    if (!Array.isArray(value) || value.length > 64) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot delivery targets are invalid");
    }
    const targets: BotDeliveryTargetReference[] = [];
    const identifiers = new Set<string>();
    const aliases = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate) || !exactKeys(candidate, ["alias", "deliveryTargetId"])) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot delivery targets are invalid");
        }
        const alias = candidate["alias"];
        const deliveryTargetId = candidate["deliveryTargetId"];
        if (
            typeof alias !== "string" ||
            typeof deliveryTargetId !== "string" ||
            aliases.has(alias) ||
            identifiers.has(deliveryTargetId)
        ) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot delivery targets are invalid");
        }
        aliases.add(alias);
        identifiers.add(deliveryTargetId);
        targets.push({ alias, deliveryTargetId });
    }
    return Object.freeze(targets);
}

function decodeCompletionPolicy(encoded: string): NoBotCompletionDeliveryPolicy {
    const value = parseObject(encoded);
    if (value["kind"] === "none" && exactKeys(value, ["kind"])) {
        return new NoBotCompletionDeliveryPolicy();
    }
    throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot completion policy is invalid");
}

function decodeRequiredCompletionPolicy(encoded: string): RequiredBotCompletionDeliveryPolicy {
    const value = parseObject(encoded);
    if (
        value["kind"] !== "required" ||
        !exactKeys(value, ["deliveryTargetId", "kind", "messageTemplate"]) ||
        typeof value["deliveryTargetId"] !== "string" ||
        typeof value["messageTemplate"] !== "string"
    ) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot completion policy is invalid");
    }
    return new RequiredBotCompletionDeliveryPolicy(value["deliveryTargetId"], value["messageTemplate"]);
}

function decodeReplyRoute(encoded: string): OwnerBotReplyRoute {
    const value = parseObject(encoded);
    if (value["kind"] === "owner" && exactKeys(value, ["kind"])) {
        return new OwnerBotReplyRoute();
    }
    throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot reply route is invalid");
}

function decodeConnectedReplyRoute(encoded: string): BotConnectionReplyRoute {
    const value = parseObject(encoded);
    if (
        value["kind"] !== "connection" ||
        !exactKeys(value, ["connectionId", "deliveryTargetId", "kind"]) ||
        typeof value["connectionId"] !== "string" ||
        typeof value["deliveryTargetId"] !== "string"
    ) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot reply route is invalid");
    }
    return new BotConnectionReplyRoute(value["connectionId"], value["deliveryTargetId"]);
}

function contextFromRow(row: DoSqlRow): BotSessionContextRecord {
    const completion = parseObject(rowText(row, "completion_policy_json"));
    const reply = parseObject(rowText(row, "reply_route_json"));
    if (completion["kind"] === "required" && reply["kind"] === "connection") {
        return new ConnectedRequiredBotSessionContext(
            row,
            decodeRequiredCompletionPolicy(rowText(row, "completion_policy_json")),
            decodeConnectedReplyRoute(rowText(row, "reply_route_json")),
        );
    }
    if (completion["kind"] === "required") {
        return new RequiredCompletionBotSessionContext(
            row,
            decodeRequiredCompletionPolicy(rowText(row, "completion_policy_json")),
        );
    }
    if (reply["kind"] === "connection") {
        return new ConnectedBotSessionContext(row, decodeConnectedReplyRoute(rowText(row, "reply_route_json")));
    }
    decodeCompletionPolicy(rowText(row, "completion_policy_json"));
    decodeReplyRoute(rowText(row, "reply_route_json"));
    return new BotSessionContextRecord(row);
}

function executionFromRow(row: DoSqlRow): BotExecutionRecord {
    return new BotExecutionRecord(
        rowText(row, "execution_id"),
        rowText(row, "capability_id"),
        rowText(row, "bot_id"),
        rowText(row, "conversation_id"),
        rowText(row, "session_id"),
        rowText(row, "turn_id"),
        rowText(row, "behavior_revision_id"),
        rowText(row, "binding_id"),
        rowInteger(row, "binding_revision"),
        rowText(row, "runtime_id"),
        new Date(rowInteger(row, "deadline_at")).toISOString(),
    );
}

function pendingOutboundFromRow(row: DoSqlRow, duplicate = false): BotOutboundAcceptance {
    return new BotOutboundAcceptance(
        rowText(row, "outbound_message_id"),
        rowText(row, "bot_id"),
        rowText(row, "conversation_id"),
        rowText(row, "turn_id"),
        rowText(row, "behavior_revision_id"),
        rowText(row, "binding_id"),
        rowInteger(row, "binding_revision"),
        rowText(row, "execution_id"),
        rowText(row, "delivery_target_id"),
        rowText(row, "idempotency_key"),
        rowText(row, "text"),
        new Date(rowInteger(row, "accepted_at")).toISOString(),
        new Date(rowInteger(row, "expires_at")).toISOString(),
        duplicate,
    );
}

export class BotSessionService {
    readonly #storage: BotSessionStorage;
    readonly #sessions: BotBackingSessionRuntime;

    constructor(storage: BotSessionStorage, sessions: BotBackingSessionRuntime) {
        this.#storage = storage;
        this.#sessions = sessions;
    }

    readonly authorizeExecutionCapability = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ExecutionPermit> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(executionId, "execution");
        const secretDigest = await hashSecret(capabilitySecret);
        signal.throwIfAborted();
        const execution = this.#storage.readCapability({ scopeKey: scopeKey(scope), sessionId, executionId })[0];
        if (execution === undefined || rowText(execution, "secret_digest") !== secretDigest) {
            throw new BotSessionRuntimeError("execution_capability_invalid", "The Bot execution capability is invalid");
        }
        if (
            rowText(execution, "state") !== "active" ||
            execution["revoked_at"] !== null ||
            rowInteger(execution, "expires_at") <= now
        ) {
            throw new BotSessionRuntimeError(
                "execution_capability_expired",
                "The Bot execution capability has expired",
            );
        }
        const usageLimit = rowInteger(execution, "usage_limit");
        const usageCount = rowInteger(execution, "usage_count");
        if (usageCount >= usageLimit) {
            throw new BotSessionRuntimeError("queue_full", "The Bot execution outbound limit was reached");
        }
        return new ExecutionPermit(
            scope,
            rowText(execution, "capability_id"),
            rowText(execution, "execution_id"),
            rowText(execution, "bot_id"),
            rowText(execution, "conversation_id"),
            rowText(execution, "session_id"),
            rowText(execution, "turn_id"),
            rowText(execution, "behavior_revision_id"),
            rowText(execution, "binding_id"),
            rowInteger(execution, "binding_revision"),
            rowText(execution, "runtime_id"),
            rowText(execution, "operation"),
            new Set(decodeIdentifierArray(rowText(execution, "allowed_delivery_target_ids_json"))),
            rowInteger(execution, "expires_at"),
            usageLimit - usageCount,
        );
    };

    readonly provisionConversation = async (
        scope: ProjectScope,
        provisioning: BotSessionProvisioning,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        const key = scopeKey(scope);
        const existing = this.#storage.readContext({ scopeKey: key, sessionId: provisioning.sessionId })[0];
        if (existing !== undefined) {
            const context = contextFromRow(existing);
            if (
                context.conversationId !== provisioning.conversationId ||
                context.botId !== provisioning.botId ||
                context.behaviorRevisionId !== provisioning.behaviorRevisionId ||
                context.bindingId !== provisioning.bindingId ||
                context.bindingRevision !== provisioning.bindingRevision ||
                context.runtimeId !== provisioning.runtimeId
            ) {
                throw new BotSessionRuntimeError(
                    "conversation_access_denied",
                    "The Session is already attached to another Bot conversation",
                );
            }
            return;
        }
        try {
            await this.#sessions.createSession(
                scope,
                new CreateSessionRequest(
                    provisioning.sessionId,
                    provisioning.runtimeId,
                    provisioning.agentRef,
                    provisioning.bindingId,
                    provisioning.workspaceRef,
                    new SessionRecordingPolicy(
                        "full",
                        DEFAULT_RETENTION_MILLISECONDS,
                        DEFAULT_HOT_EVENT_LIMIT,
                        DEFAULT_CONTENT_LIMIT_BYTES,
                    ),
                    provisioning.title,
                    provisioning.creatorPrincipalId,
                ),
                now,
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            try {
                await this.#sessions.readSession(scope, provisioning.sessionId, signal);
            } catch {
                signal.throwIfAborted();
                throw new BotSessionRuntimeError(
                    "session_storage_unavailable",
                    "The Bot conversation could not be provisioned",
                    { cause },
                );
            }
        }
        signal.throwIfAborted();
        this.#storage.insertContext({ scopeKey: key, provisioning, createdAt: now });
    };

    readonly acceptTurn = async (
        scope: ProjectScope,
        sessionId: string,
        submission: BotTurnSubmission,
        now: number,
        signal: AbortSignal,
    ): Promise<BotTurnAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(submission.clientMessageId, "client message");
        if (submission.actorRef.length === 0 || submission.actorRef.length > MAX_ACTOR_REFERENCE_LENGTH) {
            throw new BotSessionRuntimeError("invalid_request", "The actor reference is invalid");
        }
        const key = scopeKey(scope);
        const contextRow = this.#storage.readContext({ scopeKey: key, sessionId })[0];
        if (contextRow === undefined) {
            throw new BotSessionRuntimeError("conversation_access_denied", "The Bot conversation does not exist");
        }
        const context = contextFromRow(contextRow);
        let sessionBindingId = context.bindingId;
        let workspaceRef = context.workspaceRef;
        if (context.replyRoute instanceof OwnerBotReplyRoute) {
            const session = await this.#sessions.readSession(scope, sessionId, signal);
            if (
                session.defaultBinding.runtimeId !== context.runtimeId ||
                session.defaultBinding.agentRef !== context.agentRef
            ) {
                throw new BotSessionRuntimeError(
                    "conversation_access_denied",
                    "The owner conversation execution identity no longer matches its approved Bot binding",
                );
            }
            sessionBindingId = session.defaultBinding.bindingId;
            workspaceRef = session.defaultBinding.workspaceRef;
        }
        signal.throwIfAborted();
        const ordinaryCommand: SessionPromptCommand = {
            additionalDirectoryIds: submission.additionalDirectoryIds,
            agentId: context.agentRef,
            bindingId: sessionBindingId,
            commandId: submission.clientMessageId,
            directoryId: workspaceRef,
            images: decodePromptImagesValue(submission.images),
            kind: SESSION_PROMPT_KIND,
            prompt: submission.prompt,
            resources: decodePromptResourcesValue(submission.resources),
            sessionId,
        };
        const encodedOrdinaryCommand = encodeSessionPromptCommand(ordinaryCommand);
        const requestDigest = await sha256(
            new TextEncoder().encode(JSON.stringify({ actorRef: submission.actorRef, command: ordinaryCommand })),
        );
        const turnId = `turn_${crypto.randomUUID()}`;
        const executionId = `exe_${crypto.randomUUID()}`;
        const capabilityId = `bcp_${crypto.randomUUID()}`;
        const capabilitySecret = createRandomToken(32);
        const capabilityDigest = await hashSecret(capabilitySecret);
        const deadlineAt = now + BOT_EXECUTION_LIFETIME_MILLISECONDS;
        signal.throwIfAborted();
        const botCommand = decodeBotSessionPromptCommand(
            encodeBotSessionPromptCommand(
                new BotSessionPromptCommand(
                    sessionId,
                    submission.clientMessageId,
                    context.agentRef,
                    context.bindingId,
                    workspaceRef,
                    submission.additionalDirectoryIds,
                    submission.images,
                    submission.resources,
                    submission.prompt,
                    executionId,
                    capabilityId,
                    capabilitySecret,
                    new Date(deadlineAt).toISOString(),
                    context.botId,
                    context.conversationId,
                    turnId,
                    context.behaviorRevisionId,
                    context.bindingRevision,
                    context.localGrantId,
                    context.behaviorInstructions,
                    context.behaviorDigest,
                    context.allowedDeliveryTargets,
                    context.replyRoute,
                ),
            ),
        );
        const result = this.#storage.insertTurnExecution({
            turn: {
                scopeKey: key,
                sessionId,
                commandId: submission.clientMessageId,
                turnId,
                bindingId: sessionBindingId,
                idempotencyKey: submission.clientMessageId,
                requestHash: requestDigest,
                commandJson: encodedOrdinaryCommand,
                createdAt: now,
                updatedAt: now,
            },
            receipt: {
                scopeKey: key,
                sessionId,
                commandKind: BOT_SESSION_PROMPT_KIND,
                idempotencyKey: submission.clientMessageId,
                requestHash: requestDigest,
                resultId: turnId,
                acceptedAt: now,
            },
            dispatch: {
                scopeKey: key,
                sessionId,
                workId: `dispatch_${turnId}`,
                runtimeId: context.runtimeId,
                deliveryPayload: encodeBotSessionPromptCommand(botCommand),
                queuedAt: now,
            },
            execution: {
                scopeKey: key,
                sessionId,
                executionId,
                botId: context.botId,
                conversationId: context.conversationId,
                turnId,
                commandId: submission.clientMessageId,
                behaviorRevisionId: context.behaviorRevisionId,
                bindingId: context.bindingId,
                bindingRevision: context.bindingRevision,
                runtimeId: context.runtimeId,
                createdAt: now,
                deadlineAt,
            },
            capability: {
                scopeKey: key,
                sessionId,
                capabilityId,
                executionId,
                secretDigest: capabilityDigest,
                allowedDeliveryTargetIds: context.allowedDeliveryTargets.map((target) => target.deliveryTargetId),
                usageLimit: BOT_EXECUTION_OUTBOUND_USAGE_LIMIT,
                expiresAt: deadlineAt,
            },
        });
        switch (result.kind) {
            case "existing":
                if (rowText(result.receipt, "request_hash") !== requestDigest) {
                    throw new BotSessionRuntimeError(
                        "idempotency_conflict",
                        "The client message identifier was reused with different content",
                    );
                }
                return new BotTurnAcceptance(executionFromRow(result.receipt), true);
            case "busy":
                throw new BotSessionRuntimeError("session_busy", "The Bot conversation already has an active turn");
            case "inserted":
                break;
            default: {
                const unreachable: never = result;
                return unreachable;
            }
        }
        return new BotTurnAcceptance(
            new BotExecutionRecord(
                executionId,
                capabilityId,
                context.botId,
                context.conversationId,
                sessionId,
                turnId,
                context.behaviorRevisionId,
                context.bindingId,
                context.bindingRevision,
                context.runtimeId,
                new Date(deadlineAt).toISOString(),
            ),
            false,
        );
    };

    readonly acceptOutbound = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        submission: BotOutboundSubmission,
        now: number,
        signal: AbortSignal,
    ): Promise<BotOutboundAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(executionId, "execution");
        validateDomainIdentifier(submission.idempotencyKey, "idempotency key");
        validateDomainIdentifier(submission.deliveryTargetId, "delivery target");
        if (submission.text.trim().length === 0 || submission.text.length > MAX_OUTBOUND_MESSAGE_LENGTH) {
            throw new BotSessionRuntimeError("invalid_request", "The outbound message text is invalid");
        }
        const secretDigest = await hashSecret(capabilitySecret);
        const requestDigest = await sha256(
            new TextEncoder().encode(
                JSON.stringify({ deliveryTargetId: submission.deliveryTargetId, text: submission.text }),
            ),
        );
        signal.throwIfAborted();
        const key = scopeKey(scope);
        const execution = this.#storage.readOutboundCapability({ scopeKey: key, sessionId, executionId })[0];
        if (execution === undefined || rowText(execution, "secret_digest") !== secretDigest) {
            throw new BotSessionRuntimeError("execution_capability_invalid", "The Bot execution capability is invalid");
        }
        if (
            rowText(execution, "state") !== "active" ||
            execution["revoked_at"] !== null ||
            rowInteger(execution, "expires_at") <= now
        ) {
            throw new BotSessionRuntimeError(
                "execution_capability_expired",
                "The Bot execution capability has expired",
            );
        }
        const allowed = decodeIdentifierArray(rowText(execution, "allowed_delivery_target_ids_json"));
        if (!allowed.includes(submission.deliveryTargetId)) {
            throw new BotSessionRuntimeError(
                "delivery_target_not_allowed",
                "The delivery target is not allowed for this Bot execution",
            );
        }
        const outboundMessageId = `out_${crypto.randomUUID()}`;
        const expiresAt = now + BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS;
        const result = this.#storage.insertOutboundWithUsage({
            scopeKey: key,
            sessionId,
            outboundMessageId,
            executionId,
            botId: rowText(execution, "bot_id"),
            deliveryTargetId: submission.deliveryTargetId,
            idempotencyKey: submission.idempotencyKey,
            requestDigest,
            text: submission.text,
            acceptedAt: now,
            expiresAt,
        });
        switch (result.kind) {
            case "existing":
                if (rowText(result.receipt, "request_digest") !== requestDigest) {
                    throw new BotSessionRuntimeError(
                        "idempotency_conflict",
                        "The outbound idempotency key was reused with different content",
                    );
                }
                return pendingOutboundFromRow(result.receipt, true);
            case "limit-reached":
                throw new BotSessionRuntimeError("queue_full", "The Bot execution outbound limit was reached");
            case "unavailable":
                throw new BotSessionRuntimeError(
                    "session_storage_unavailable",
                    "The outbound message was not committed",
                );
            case "inserted":
                return pendingOutboundFromRow(result.receipt);
            default: {
                const unreachable: never = result;
                return unreachable;
            }
        }
    };

    readonly listPendingOutbound = async (
        scope: ProjectScope,
        sessionId: string,
        limit: number,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly PendingBotOutbound[]> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        const boundedLimit = Math.min(Math.max(limit, 1), MAX_PENDING_OUTBOUND_BATCH);
        const key = scopeKey(scope);
        this.#storage.expireOutbound({ failedAt: now, scopeKey: key, sessionId, expiresAt: now });
        return this.#storage
            .listPendingOutbound({ scopeKey: key, sessionId, limit: boundedLimit })
            .map(
                (row) =>
                    new PendingBotOutbound(
                        rowText(row, "outbound_message_id"),
                        rowText(row, "bot_id"),
                        rowText(row, "conversation_id"),
                        rowText(row, "turn_id"),
                        rowText(row, "behavior_revision_id"),
                        rowText(row, "binding_id"),
                        rowInteger(row, "binding_revision"),
                        rowText(row, "execution_id"),
                        rowText(row, "delivery_target_id"),
                        rowText(row, "idempotency_key"),
                        rowText(row, "text"),
                        new Date(rowInteger(row, "accepted_at")).toISOString(),
                        new Date(rowInteger(row, "expires_at")).toISOString(),
                    ),
            );
    };

    readonly readConversationEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<BotConversationEventPage> => {
        signal.throwIfAborted();
        const key = scopeKey(scope);
        const contextRow = this.#storage.readContext({ scopeKey: key, sessionId })[0];
        if (contextRow === undefined) {
            throw new BotSessionRuntimeError("conversation_access_denied", "The Bot conversation does not exist");
        }
        const context = contextFromRow(contextRow);
        const page = await this.#sessions.readEvents(
            scope,
            sessionId,
            cursor.length === 0 ? null : cursor,
            limit,
            signal,
        );
        const events: BotConversationEvent[] = [];
        for (const event of page.events) {
            const turnId = this.eventTurnId(key, sessionId, event.source, event.payload);
            if (turnId.length === 0) {
                continue;
            }
            const payload = parseObject(event.payload);
            const kind = payload["kind"];
            if (typeof kind !== "string") {
                throw new BotSessionRuntimeError(
                    "session_storage_unavailable",
                    "The Bot conversation event is invalid",
                );
            }
            events.push(
                new BotConversationEvent(
                    event.eventId,
                    context.conversationId,
                    turnId,
                    event.sequence,
                    event.recordedAt,
                    context.behaviorRevisionId,
                    kind,
                    payload,
                ),
            );
        }
        return new BotConversationEventPage(page.cursor, events, page.hasMore);
    };

    readonly markOutboundForwarded = async (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const result = this.#storage.markForwarded({
            forwardedAt: now,
            scopeKey: scopeKey(scope),
            sessionId,
            outboundMessageId,
        });
        if (result.changes !== 1) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The outbound message does not exist");
        }
    };

    readonly markOutboundTerminalFailure = async (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        failureCode: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(failureCode, "failure code");
        const result = this.#storage.markTerminalFailure({
            failedAt: now,
            failureCode,
            scopeKey: scopeKey(scope),
            sessionId,
            outboundMessageId,
        });
        if (result.changes !== 1) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The outbound message does not exist");
        }
    };

    readonly settleExecution = async (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        outcome: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly PendingBotOutbound[]> => {
        signal.throwIfAborted();
        const key = scopeKey(scope);
        const contextRow = this.#storage.readContext({ scopeKey: key, sessionId })[0];
        if (contextRow === undefined) {
            return [];
        }
        const context = contextFromRow(contextRow);
        const execution = this.#storage.readCommandExecution({ scopeKey: key, sessionId, commandId })[0];
        if (execution !== undefined && rowText(execution, "state") === "active") {
            const state = outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
            const policy = context.completionPolicy;
            const completion =
                policy instanceof RequiredBotCompletionDeliveryPolicy
                    ? {
                          outboundMessageId: `out_${crypto.randomUUID()}`,
                          botId: context.botId,
                          deliveryTargetId: policy.deliveryTargetId,
                          idempotencyKey: `completion:${rowText(execution, "turn_id")}`,
                          requestDigest: JSON.stringify({
                              deliveryTargetId: policy.deliveryTargetId,
                              text: policy.messageTemplate.replaceAll("{status}", state),
                          }),
                          text: policy.messageTemplate.replaceAll("{status}", state),
                          expiresAt: now + BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS,
                      }
                    : null;
            this.#storage.completeExecution({
                scopeKey: key,
                sessionId,
                executionId: rowText(execution, "execution_id"),
                state,
                completedAt: now,
                completion,
            });
        }
        return await this.listPendingOutbound(scope, sessionId, MAX_PENDING_OUTBOUND_BATCH, now, signal);
    };

    private readonly eventTurnId = (
        scopeKeyValue: string,
        sessionId: string,
        source: Readonly<Record<string, unknown>>,
        encodedPayload: string,
    ): string => {
        if (source["kind"] === "attempt" && typeof source["attemptId"] === "string") {
            const attempt = this.#storage.readAttemptTurn({
                scopeKey: scopeKeyValue,
                sessionId,
                attemptId: source["attemptId"],
            })[0];
            return attempt === undefined ? "" : rowText(attempt, "turn_id");
        }
        const payload = parseObject(encodedPayload);
        const commandId = payload["commandId"];
        if (typeof commandId !== "string") {
            return "";
        }
        const turn = this.#storage.readCommandTurn({ scopeKey: scopeKeyValue, sessionId, commandId })[0];
        return turn === undefined ? "" : rowText(turn, "turn_id");
    };
}

function decodeIdentifierArray(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The capability target list is invalid", {
            cause,
        });
    }
    if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== "string")) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The capability target list is invalid");
    }
    return value.filter((candidate) => typeof candidate === "string");
}
