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
} from "./bot-session-runtime.ts";
import type { SessionCommandGateway } from "./gateway/session-command-gateway.ts";
import type { SessionQueryGateway } from "./gateway/session-query-gateway.ts";
import { createRandomToken, hashSecret } from "./service/pairing/pairing.ts";
import { CreateSessionRequest, type ProjectScope, SessionRecordingPolicy } from "./service/session/session.ts";
import { sha256 } from "./service/session/session-archive-codec.ts";
import {
    DEFAULT_CONTENT_LIMIT_BYTES,
    DEFAULT_HOT_EVENT_LIMIT,
    DEFAULT_RETENTION_MILLISECONDS,
    scopeKey,
    validateDomainIdentifier,
    validateTimestamp,
} from "./service/session/session-records.ts";
import { initializeBotSessionSchema } from "./sqlite-bot-schema.ts";
import type { SessionSqlDatabase, SessionSqlRow } from "./storage/session/session-sql-database.ts";

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

    constructor(row: SessionSqlRow) {
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

    constructor(row: SessionSqlRow, completionPolicy: RequiredBotCompletionDeliveryPolicy) {
        super(row);
        this.completionPolicy = completionPolicy;
    }
}

class ConnectedBotSessionContext extends BotSessionContextRecord {
    override readonly replyRoute: BotConnectionReplyRoute;

    constructor(row: SessionSqlRow, replyRoute: BotConnectionReplyRoute) {
        super(row);
        this.replyRoute = replyRoute;
    }
}

class ConnectedRequiredBotSessionContext extends RequiredCompletionBotSessionContext {
    override readonly replyRoute: BotConnectionReplyRoute;

    constructor(
        row: SessionSqlRow,
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

function rowText(row: SessionSqlRow, key: string, allowEmpty = false): string {
    const value = row[key];
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot session record is invalid");
    }
    return value;
}

function rowInteger(row: SessionSqlRow, key: string): number {
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

function contextFromRow(row: SessionSqlRow): BotSessionContextRecord {
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

function executionFromRow(row: SessionSqlRow): BotExecutionRecord {
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

function pendingOutboundFromRow(row: SessionSqlRow, duplicate = false): BotOutboundAcceptance {
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

export class SqliteBotSessionRuntime {
    readonly #database: SessionSqlDatabase;
    readonly #sessions: BotBackingSessionRuntime;

    constructor(database: SessionSqlDatabase, sessions: BotBackingSessionRuntime) {
        this.#database = database;
        this.#sessions = sessions;
        initializeBotSessionSchema(database);
    }

    readonly authorizeExecutionCapability = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(executionId, "execution");
        const secretDigest = await hashSecret(capabilitySecret);
        signal.throwIfAborted();
        const execution = this.#database.query(
            `SELECT e.state, c.secret_digest, c.expires_at, c.revoked_at
               FROM bot_executions AS e
               INNER JOIN bot_execution_capabilities AS c
                 ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                AND c.execution_id = e.execution_id
              WHERE e.scope_key = ? AND e.session_id = ? AND e.execution_id = ?`,
            [scopeKey(scope), sessionId, executionId],
        )[0];
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
        const existing = this.#database.query(
            `SELECT * FROM bot_session_context WHERE scope_key = ? AND session_id = ?`,
            [key, provisioning.sessionId],
        )[0];
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
        this.#database.run(
            `INSERT INTO bot_session_context (
               scope_key, session_id, conversation_id, bot_id,
               behavior_revision_id, binding_id, binding_revision,
               runtime_id, agent_ref, workspace_ref, agent_config_revision,
               local_grant_id, creator_kind, creator_principal_id,
               behavior_instructions, behavior_digest,
               allowed_delivery_targets_json, completion_policy_json,
               reply_route_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                key,
                provisioning.sessionId,
                provisioning.conversationId,
                provisioning.botId,
                provisioning.behaviorRevisionId,
                provisioning.bindingId,
                provisioning.bindingRevision,
                provisioning.runtimeId,
                provisioning.agentRef,
                provisioning.workspaceRef,
                provisioning.agentConfigRevision,
                provisioning.localGrantId,
                provisioning.creatorKind,
                provisioning.creatorPrincipalId,
                provisioning.behaviorInstructions,
                provisioning.behaviorDigest,
                JSON.stringify(provisioning.allowedDeliveryTargets),
                JSON.stringify(provisioning.completionPolicy),
                JSON.stringify(provisioning.replyRoute),
                now,
            ],
        );
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
        const contextRow = this.#database.query(
            `SELECT * FROM bot_session_context WHERE scope_key = ? AND session_id = ?`,
            [key, sessionId],
        )[0];
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
        return this.#database.transaction(() => {
            const duplicate = this.#database.query(
                `SELECT e.*, c.capability_id, t.request_hash
                   FROM command_receipts r
                   INNER JOIN turns t
                     ON t.scope_key = r.scope_key AND t.session_id = r.session_id
                    AND t.turn_id = r.result_id
                   INNER JOIN bot_executions e
                     ON e.scope_key = t.scope_key AND e.session_id = t.session_id
                    AND e.turn_id = t.turn_id
                   INNER JOIN bot_execution_capabilities c
                     ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                    AND c.execution_id = e.execution_id
                  WHERE r.scope_key = ? AND r.session_id = ?
                    AND r.command_kind = ? AND r.idempotency_key = ?`,
                [key, sessionId, BOT_SESSION_PROMPT_KIND, submission.clientMessageId],
            )[0];
            if (duplicate !== undefined) {
                if (rowText(duplicate, "request_hash") !== requestDigest) {
                    throw new BotSessionRuntimeError(
                        "idempotency_conflict",
                        "The client message identifier was reused with different content",
                    );
                }
                return new BotTurnAcceptance(executionFromRow(duplicate), true);
            }
            const active = this.#database.query(
                `SELECT 1 AS active FROM turns
                  WHERE scope_key = ? AND session_id = ?
                    AND state IN ('queued', 'running', 'indeterminate') LIMIT 1`,
                [key, sessionId],
            )[0];
            if (active !== undefined) {
                throw new BotSessionRuntimeError("session_busy", "The Bot conversation already has an active turn");
            }
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
            this.#database.run(
                `INSERT INTO turns (
                   scope_key, session_id, command_id, turn_id, binding_id,
                   idempotency_key, request_hash, command_json, state,
                   created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
                [
                    key,
                    sessionId,
                    submission.clientMessageId,
                    turnId,
                    sessionBindingId,
                    submission.clientMessageId,
                    requestDigest,
                    encodedOrdinaryCommand,
                    now,
                    now,
                ],
            );
            this.#database.run(
                `INSERT INTO command_receipts (
                   scope_key, session_id, command_kind, idempotency_key,
                   request_hash, result_id, accepted_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [key, sessionId, BOT_SESSION_PROMPT_KIND, submission.clientMessageId, requestDigest, turnId, now],
            );
            this.#database.run(
                `INSERT INTO pending_work (
                   scope_key, session_id, work_id, work_kind, runtime_id,
                   delivery_payload, state, queued_at
                 ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
                [
                    key,
                    sessionId,
                    `dispatch_${turnId}`,
                    context.runtimeId,
                    encodeBotSessionPromptCommand(botCommand),
                    now,
                ],
            );
            this.#database.run(
                `INSERT INTO bot_executions (
                   scope_key, session_id, execution_id, bot_id, conversation_id,
                   turn_id, command_id, behavior_revision_id, binding_id,
                   binding_revision, runtime_id, state, created_at, deadline_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                [
                    key,
                    sessionId,
                    executionId,
                    context.botId,
                    context.conversationId,
                    turnId,
                    submission.clientMessageId,
                    context.behaviorRevisionId,
                    context.bindingId,
                    context.bindingRevision,
                    context.runtimeId,
                    now,
                    deadlineAt,
                ],
            );
            this.#database.run(
                `INSERT INTO bot_execution_capabilities (
                   scope_key, session_id, capability_id, execution_id,
                   secret_digest, operation, allowed_delivery_target_ids_json,
                   usage_limit, expires_at
                 ) VALUES (?, ?, ?, ?, ?, 'outbound-message:create', ?, ?, ?)`,
                [
                    key,
                    sessionId,
                    capabilityId,
                    executionId,
                    capabilityDigest,
                    JSON.stringify(context.allowedDeliveryTargets.map((target) => target.deliveryTargetId)),
                    BOT_EXECUTION_OUTBOUND_USAGE_LIMIT,
                    deadlineAt,
                ],
            );
            this.#database.run(`UPDATE sessions SET updated_at = ? WHERE scope_key = ? AND session_id = ?`, [
                now,
                key,
                sessionId,
            ]);
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
        });
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
        return this.#database.transaction(() => {
            const execution = this.#database.query(
                `SELECT e.*, c.capability_id, c.secret_digest, c.allowed_delivery_target_ids_json,
                        c.usage_limit, c.usage_count, c.expires_at, c.revoked_at
                   FROM bot_executions e
                   INNER JOIN bot_execution_capabilities c
                     ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                    AND c.execution_id = e.execution_id
                  WHERE e.scope_key = ? AND e.session_id = ? AND e.execution_id = ?`,
                [key, sessionId, executionId],
            )[0];
            if (execution === undefined || rowText(execution, "secret_digest") !== secretDigest) {
                throw new BotSessionRuntimeError(
                    "execution_capability_invalid",
                    "The Bot execution capability is invalid",
                );
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
            const duplicate = this.#database.query(
                `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.execution_id = ? AND requests.idempotency_key = ?`,
                [key, sessionId, executionId, submission.idempotencyKey],
            )[0];
            if (duplicate !== undefined) {
                if (rowText(duplicate, "request_digest") !== requestDigest) {
                    throw new BotSessionRuntimeError(
                        "idempotency_conflict",
                        "The outbound idempotency key was reused with different content",
                    );
                }
                return pendingOutboundFromRow(duplicate, true);
            }
            if (rowInteger(execution, "usage_count") >= rowInteger(execution, "usage_limit")) {
                throw new BotSessionRuntimeError("queue_full", "The Bot execution outbound limit was reached");
            }
            const outboundMessageId = `out_${crypto.randomUUID()}`;
            const expiresAt = now + BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS;
            this.#database.run(
                `INSERT INTO bot_outbound_requests (
                   scope_key, session_id, outbound_message_id, execution_id,
                   bot_id, delivery_target_id, idempotency_key, request_digest,
                   text, accepted_at, expires_at, state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
                [
                    key,
                    sessionId,
                    outboundMessageId,
                    executionId,
                    rowText(execution, "bot_id"),
                    submission.deliveryTargetId,
                    submission.idempotencyKey,
                    requestDigest,
                    submission.text,
                    now,
                    expiresAt,
                ],
            );
            this.#database.run(
                `UPDATE bot_execution_capabilities
                    SET usage_count = usage_count + 1
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ?`,
                [key, sessionId, executionId],
            );
            const accepted = this.#database.query(
                `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.outbound_message_id = ?`,
                [key, sessionId, outboundMessageId],
            )[0];
            if (accepted === undefined) {
                throw new BotSessionRuntimeError(
                    "session_storage_unavailable",
                    "The outbound message was not committed",
                );
            }
            return pendingOutboundFromRow(accepted);
        });
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
        this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'terminal_failed', failed_at = ?, failure_code = 'delivery_expired'
              WHERE scope_key = ? AND session_id = ? AND state = 'accepted' AND expires_at <= ?`,
            [now, key, sessionId, now],
        );
        return this.#database
            .query(
                `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.state = 'accepted'
                  ORDER BY requests.accepted_at, requests.outbound_message_id LIMIT ?`,
                [key, sessionId, boundedLimit],
            )
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
        const contextRow = this.#database.query(
            `SELECT * FROM bot_session_context WHERE scope_key = ? AND session_id = ?`,
            [key, sessionId],
        )[0];
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
        const result = this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'forwarded', forwarded_at = COALESCE(forwarded_at, ?)
              WHERE scope_key = ? AND session_id = ? AND outbound_message_id = ?`,
            [now, scopeKey(scope), sessionId, outboundMessageId],
        );
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
        const result = this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'terminal_failed', failed_at = COALESCE(failed_at, ?),
                    failure_code = COALESCE(failure_code, ?)
              WHERE scope_key = ? AND session_id = ? AND outbound_message_id = ?
                AND state IN ('accepted', 'terminal_failed')`,
            [now, failureCode, scopeKey(scope), sessionId, outboundMessageId],
        );
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
        const contextRow = this.#database.query(
            `SELECT * FROM bot_session_context WHERE scope_key = ? AND session_id = ?`,
            [key, sessionId],
        )[0];
        if (contextRow === undefined) {
            return [];
        }
        const context = contextFromRow(contextRow);
        this.#database.transaction(() => {
            const execution = this.#database.query(
                `SELECT * FROM bot_executions
                  WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
                [key, sessionId, commandId],
            )[0];
            if (execution === undefined || rowText(execution, "state") !== "active") {
                return;
            }
            const state = outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
            this.#database.run(
                `UPDATE bot_executions SET state = ?, completed_at = ?
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ? AND state = 'active'`,
                [state, now, key, sessionId, rowText(execution, "execution_id")],
            );
            this.#database.run(
                `UPDATE bot_execution_capabilities SET revoked_at = COALESCE(revoked_at, ?)
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ?`,
                [now, key, sessionId, rowText(execution, "execution_id")],
            );
            if (!(context.completionPolicy instanceof RequiredBotCompletionDeliveryPolicy)) {
                return;
            }
            const idempotencyKey = `completion:${rowText(execution, "turn_id")}`;
            const text = context.completionPolicy.messageTemplate.replaceAll("{status}", state);
            const requestDigest = JSON.stringify({ deliveryTargetId: context.completionPolicy.deliveryTargetId, text });
            this.#database.run(
                `INSERT OR IGNORE INTO bot_outbound_requests (
                   scope_key, session_id, outbound_message_id, execution_id,
                   bot_id, delivery_target_id, idempotency_key, request_digest,
                   text, accepted_at, expires_at, state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
                [
                    key,
                    sessionId,
                    `out_${crypto.randomUUID()}`,
                    rowText(execution, "execution_id"),
                    context.botId,
                    context.completionPolicy.deliveryTargetId,
                    idempotencyKey,
                    requestDigest,
                    text,
                    now,
                    now + BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS,
                ],
            );
        });
        return await this.listPendingOutbound(scope, sessionId, MAX_PENDING_OUTBOUND_BATCH, now, signal);
    };

    private readonly eventTurnId = (
        scopeKeyValue: string,
        sessionId: string,
        source: Readonly<Record<string, unknown>>,
        encodedPayload: string,
    ): string => {
        if (source["kind"] === "attempt" && typeof source["attemptId"] === "string") {
            const attempt = this.#database.query(
                `SELECT turn_id FROM attempts
                  WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
                [scopeKeyValue, sessionId, source["attemptId"]],
            )[0];
            return attempt === undefined ? "" : rowText(attempt, "turn_id");
        }
        const payload = parseObject(encodedPayload);
        const commandId = payload["commandId"];
        if (typeof commandId !== "string") {
            return "";
        }
        const turn = this.#database.query(
            `SELECT turn_id FROM turns
              WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [scopeKeyValue, sessionId, commandId],
        )[0];
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
