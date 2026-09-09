import {
    ActiveBot,
    ArchivedBot,
    type BotCompletionDeliveryPolicy,
    BotDeliveryTargetReference,
    BotExecutionBindingApprovalRequest,
    type BotExecutionBindingApprovedEvent,
    type BotExecutionBindingUnavailableEvent,
    DraftBot,
    encodeBotExecutionBindingApprovalRequest,
    NoBotCompletionDeliveryPolicy,
    RequiredBotCompletionDeliveryPolicy,
    SuspendedBot,
} from "@moxt-ai/mobius-protocol";
import {
    createRandomToken,
    type ProjectScope,
    parseAgents,
    VerifiedChannelAccess,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";

import { BotApiError } from "./bot-api-error.ts";
import type { BotOwnerAccess, ProjectOwnerAccess } from "./d1-bot-auth.ts";

interface BotRow {
    readonly active_behavior_revision_id: unknown;
    readonly active_binding_id: unknown;
    readonly archived_at: unknown;
    readonly bot_id: string;
    readonly created_at: number;
    readonly current_profile_revision_id: string;
    readonly lifecycle: string;
    readonly lifecycle_revision: number;
    readonly project_id: string;
    readonly suspended_at: unknown;
    readonly tenant_id: string;
    readonly updated_at: number;
}

interface BehaviorRow {
    readonly agent_configuration_json: string;
    readonly behavior_revision_id: string;
    readonly bot_id: string;
    readonly content_digest: string;
    readonly created_at: number;
    readonly instructions: string;
    readonly lifecycle: string;
    readonly required_capabilities_json: string;
    readonly revision_number: number;
}

interface RuntimeRow {
    readonly agents_json: string;
    readonly channel_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
}

interface TargetRow {
    readonly alias: string;
    readonly bot_id: string;
    readonly connection_lifecycle: string;
    readonly delivery_target_id: string;
    readonly lifecycle: string;
    readonly owner_approved: number;
}

interface BindingRow {
    readonly agent_config_revision: number;
    readonly agent_ref: string;
    readonly allowed_delivery_target_ids_json: string;
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly completion_policy_json: string;
    readonly created_at: number;
    readonly lifecycle: string;
    readonly local_grant_id: unknown;
    readonly runtime_id: string;
    readonly workspace_ref: string;
}

interface BotProfileRow extends BotRow {
    readonly avatar_ref: string;
    readonly description: string;
    readonly display_name: string;
    readonly profile_revision_number: number;
}

interface BindingEventIdentity {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly requestId: string;
}

export class CreatedBindingRequest {
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly runtimeAccess: VerifiedChannelAccess;

    constructor(bindingId: string, bindingRevision: number, runtimeAccess: VerifiedChannelAccess) {
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeAccess = runtimeAccess;
    }
}

export class ApprovedBindingContext {
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
    readonly localGrantId: string;
    readonly runtimeId: string;
    readonly workspaceRef: string;

    constructor(
        binding: BindingRow,
        behavior: BehaviorRow,
        targets: readonly BotDeliveryTargetReference[],
        completionPolicy: BotCompletionDeliveryPolicy,
    ) {
        if (typeof binding.local_grant_id !== "string") {
            throw new BotApiError("binding_not_approved", "The Bot binding is not approved", 409);
        }
        this.bindingId = binding.binding_id;
        this.bindingRevision = binding.binding_revision;
        this.botId = binding.bot_id;
        this.behaviorRevisionId = binding.behavior_revision_id;
        this.runtimeId = binding.runtime_id;
        this.agentRef = binding.agent_ref;
        this.workspaceRef = binding.workspace_ref;
        this.agentConfigRevision = binding.agent_config_revision;
        this.localGrantId = binding.local_grant_id;
        this.behaviorInstructions = behavior.instructions;
        this.behaviorDigest = behavior.content_digest;
        this.allowedDeliveryTargets = Object.freeze([...targets]);
        this.completionPolicy = completionPolicy;
    }
}

function stringArray(encoded: string, message: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", message, 503, { cause });
    }
    if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== "string")) {
        throw new BotApiError("bot_service_unavailable", message, 503);
    }
    return value.filter((candidate) => typeof candidate === "string");
}

function completionPolicy(encoded: string): BotCompletionDeliveryPolicy {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", 503, { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", 503);
    }
    if (Reflect.get(value, "kind") === "none" && Object.keys(value).length === 1) {
        return new NoBotCompletionDeliveryPolicy();
    }
    if (
        Reflect.get(value, "kind") === "required" &&
        typeof Reflect.get(value, "deliveryTargetId") === "string" &&
        typeof Reflect.get(value, "messageTemplate") === "string" &&
        Object.keys(value).length === 3
    ) {
        return new RequiredBotCompletionDeliveryPolicy(
            Reflect.get(value, "deliveryTargetId"),
            Reflect.get(value, "messageTemplate"),
        );
    }
    throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", 503);
}

function timestamp(value: unknown): string {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new BotApiError("bot_service_unavailable", "The Bot record is invalid", 503);
    }
    return new Date(value).toISOString();
}

function botResource(row: BotProfileRow): object {
    const createdAt = timestamp(row.created_at);
    const updatedAt = timestamp(row.updated_at);
    let resource: object;
    if (row.lifecycle === "draft") {
        resource = new DraftBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
        );
    } else if (
        row.lifecycle === "active" &&
        typeof row.active_behavior_revision_id === "string" &&
        typeof row.active_binding_id === "string"
    ) {
        resource = new ActiveBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.active_behavior_revision_id,
            row.active_binding_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
        );
    } else if (
        row.lifecycle === "suspended" &&
        typeof row.active_behavior_revision_id === "string" &&
        typeof row.active_binding_id === "string"
    ) {
        resource = new SuspendedBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.active_behavior_revision_id,
            row.active_binding_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
            timestamp(row.suspended_at),
        );
    } else if (row.lifecycle === "archived") {
        resource = new ArchivedBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
            timestamp(row.archived_at),
        );
    } else {
        throw new BotApiError("bot_service_unavailable", "The Bot lifecycle is invalid", 503);
    }
    return {
        ...resource,
        avatarRef: row.avatar_ref,
        description: row.description,
        displayName: row.display_name,
        profileRevision: row.profile_revision_number,
    };
}

export class D1BotControl {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly createBot = async (
        access: ProjectOwnerAccess,
        displayName: string,
        avatarRef: string,
        description: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const botId = `bot_${createRandomToken(18)}`;
        const profileRevisionId = `bpr_${createRandomToken(18)}`;
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO bot_profile_revisions (
                       profile_revision_id, bot_id, revision_number,
                       display_name, avatar_ref, description, created_at
                     ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
                )
                .bind(profileRevisionId, botId, displayName, avatarRef, description, now),
            this.#database
                .prepare(
                    `INSERT INTO bots (
                       bot_id, tenant_id, project_id, current_profile_revision_id,
                       lifecycle, lifecycle_revision, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?)`,
                )
                .bind(botId, access.scope.tenantId, access.scope.projectId, profileRevisionId, now, now),
            this.audit(access.scope, botId, "owner", access.credentialId, "bot.created", botId, {}, now),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("bot_service_unavailable", "The Bot was not created", 503);
        }
        return {
            ...new DraftBot(
                botId,
                access.scope.projectId,
                profileRevisionId,
                1,
                new Date(now).toISOString(),
                new Date(now).toISOString(),
            ),
            avatarRef,
            description,
            displayName,
            profileRevision: 1,
        };
    };

    readonly createProfileRevision = async (
        access: BotOwnerAccess,
        expectedRevision: number,
        displayName: string,
        avatarRef: string,
        description: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const bot = await this.botRow(access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be changed", 409);
        }
        if (bot.lifecycle_revision !== expectedRevision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", 409);
        }
        const revisionRow = await this.#database
            .prepare(`SELECT COALESCE(MAX(revision_number), 0) AS revision FROM bot_profile_revisions WHERE bot_id = ?`)
            .bind(access.botId)
            .first<{ readonly revision: number }>();
        signal.throwIfAborted();
        const revision = (revisionRow?.revision ?? 0) + 1;
        const profileRevisionId = `bpr_${createRandomToken(18)}`;
        const nextLifecycleRevision = expectedRevision + 1;
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO bot_profile_revisions (
                       profile_revision_id, bot_id, revision_number,
                       display_name, avatar_ref, description, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(profileRevisionId, access.botId, revision, displayName, avatarRef, description, now),
            this.#database
                .prepare(
                    `UPDATE bots SET current_profile_revision_id = ?,
                        lifecycle_revision = ?, updated_at = ?
                      WHERE bot_id = ? AND lifecycle_revision = ? AND lifecycle <> 'archived'`,
                )
                .bind(profileRevisionId, nextLifecycleRevision, now, access.botId, expectedRevision),
            this.audit(
                access.scope,
                access.botId,
                "owner",
                access.credentialId,
                "bot.profile.revised",
                profileRevisionId,
                { revision: revision.toString() },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", 409);
        }
        return {
            avatarRef,
            botId: access.botId,
            createdAt: new Date(now).toISOString(),
            description,
            displayName,
            lifecycleRevision: nextLifecycleRevision,
            profileRevisionId,
            revisionNumber: revision,
        };
    };

    readonly createBehaviorRevision = async (
        access: BotOwnerAccess,
        expectedRevision: number,
        instructions: string,
        requiredCapabilities: readonly string[],
        agentConfiguration: Readonly<Record<string, unknown>>,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const bot = await this.botRow(access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be changed", 409);
        }
        const current = await this.#database
            .prepare(
                `SELECT COALESCE(MAX(revision_number), 0) AS revision FROM bot_behavior_revisions WHERE bot_id = ?`,
            )
            .bind(access.botId)
            .first<{ readonly revision: number }>();
        signal.throwIfAborted();
        if ((current?.revision ?? 0) !== expectedRevision) {
            throw new BotApiError("revision_conflict", "The Bot behavior revision changed", 409);
        }
        const revisionNumber = expectedRevision + 1;
        const behaviorRevisionId = `bbr_${createRandomToken(18)}`;
        const normalizedConfiguration = JSON.stringify(agentConfiguration);
        const normalizedCapabilities = JSON.stringify([...requiredCapabilities].sort());
        const contentDigest = await crypto.subtle
            .digest(
                "SHA-256",
                new TextEncoder().encode(
                    JSON.stringify({
                        agentConfiguration,
                        instructions,
                        requiredCapabilities: [...requiredCapabilities].sort(),
                    }),
                ),
            )
            .then((digest) =>
                Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
            );
        signal.throwIfAborted();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO bot_behavior_revisions (
                       behavior_revision_id, bot_id, revision_number, instructions,
                       required_capabilities_json, agent_configuration_json,
                       content_digest, lifecycle, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
                )
                .bind(
                    behaviorRevisionId,
                    access.botId,
                    revisionNumber,
                    instructions,
                    normalizedCapabilities,
                    normalizedConfiguration,
                    contentDigest,
                    now,
                ),
            this.audit(
                access.scope,
                access.botId,
                "owner",
                access.credentialId,
                "bot.behavior.proposed",
                behaviorRevisionId,
                { revision: revisionNumber.toString() },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("bot_service_unavailable", "The Bot behavior was not created", 503);
        }
        return {
            agentConfiguration,
            behaviorRevisionId,
            botId: access.botId,
            contentDigest,
            createdAt: new Date(now).toISOString(),
            instructions,
            lifecycle: "proposed",
            requiredCapabilities,
            revisionNumber,
        };
    };

    readonly createExecutionBinding = async (
        access: BotOwnerAccess,
        expectedRevision: number,
        behaviorRevisionId: string,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        allowedDeliveryTargetIds: readonly string[],
        policy: BotCompletionDeliveryPolicy,
        now: number,
        signal: AbortSignal,
    ): Promise<CreatedBindingRequest> => {
        signal.throwIfAborted();
        const bot = await this.botRow(access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be bound", 409);
        }
        if (bot.lifecycle_revision !== expectedRevision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", 409);
        }
        const behavior = await this.#database
            .prepare(`SELECT * FROM bot_behavior_revisions WHERE bot_id = ? AND behavior_revision_id = ?`)
            .bind(access.botId, validateIdentifier(behaviorRevisionId, "behavior_revision_id"))
            .first<BehaviorRow>();
        if (
            behavior === null ||
            (behavior.lifecycle !== "proposed" && behavior.lifecycle !== "awaiting_local_approval")
        ) {
            throw new BotApiError("behavior_not_approved", "The Bot behavior cannot be bound", 409);
        }
        const runtime = await this.#database
            .prepare(
                `SELECT channel_id, runtime_id, tenant_id, project_id, agents_json
                   FROM pairing_channels
                  WHERE runtime_id = ? AND tenant_id = ? AND project_id = ? AND status = 'paired'`,
            )
            .bind(validateIdentifier(runtimeId, "runtime_id"), access.scope.tenantId, access.scope.projectId)
            .first<RuntimeRow>();
        signal.throwIfAborted();
        if (runtime === null) {
            throw new BotApiError("binding_incompatible", "The requested Runtime is unavailable", 409);
        }
        const agents = parseAgents(runtime.agents_json);
        const agent = agents.find((candidate) => candidate.id === agentRef);
        if (agent === undefined) {
            throw new BotApiError("binding_incompatible", "The requested Agent is unavailable", 409);
        }
        const requirements = stringArray(behavior.required_capabilities_json, "The behavior requirements are invalid");
        if (requirements.includes("embedded-context") && !agent.capabilities.embeddedContextPrompt) {
            throw new BotApiError("binding_incompatible", "The Agent cannot apply the required Bot behavior", 409);
        }
        const targets = await this.targets(access.botId, allowedDeliveryTargetIds, signal);
        if (
            policy instanceof RequiredBotCompletionDeliveryPolicy &&
            !allowedDeliveryTargetIds.includes(policy.deliveryTargetId)
        ) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The completion target is not included in the binding",
                403,
            );
        }
        const revisionRow = await this.#database
            .prepare(
                `SELECT COALESCE(MAX(binding_revision), 0) AS revision FROM bot_execution_bindings WHERE bot_id = ?`,
            )
            .bind(access.botId)
            .first<{ readonly revision: number }>();
        const bindingRevision = (revisionRow?.revision ?? 0) + 1;
        const bindingId = `beb_${createRandomToken(18)}`;
        const requestId = `apr_${createRandomToken(18)}`;
        const outboxId = `bco_${createRandomToken(18)}`;
        const request = new BotExecutionBindingApprovalRequest(
            requestId,
            access.botId,
            behavior.behavior_revision_id,
            bindingId,
            bindingRevision,
            runtime.runtime_id,
            agentRef,
            workspaceRef,
            agentConfigRevision,
            behavior.instructions,
            behavior.content_digest,
            requirements,
            targets,
            policy,
        );
        const results = await this.#database
            .batch([
                this.#database
                    .prepare(
                        `INSERT INTO bot_execution_bindings (
                       binding_id, bot_id, behavior_revision_id, binding_revision,
                       runtime_id, agent_ref, workspace_ref, agent_config_revision,
                       allowed_delivery_target_ids_json, completion_policy_json,
                       lifecycle, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
                    )
                    .bind(
                        bindingId,
                        access.botId,
                        behavior.behavior_revision_id,
                        bindingRevision,
                        runtime.runtime_id,
                        agentRef,
                        workspaceRef,
                        agentConfigRevision,
                        JSON.stringify(allowedDeliveryTargetIds),
                        JSON.stringify(policy),
                        now,
                    ),
                this.#database
                    .prepare(
                        `UPDATE bot_behavior_revisions SET lifecycle = 'awaiting_local_approval'
                      WHERE behavior_revision_id = ? AND bot_id = ?
                        AND lifecycle IN ('proposed', 'awaiting_local_approval')`,
                    )
                    .bind(behavior.behavior_revision_id, access.botId),
                this.#database
                    .prepare(
                        `INSERT INTO bot_control_outbox (
                       outbox_id, bot_id, subject_id, runtime_id,
                       message_kind, payload, state, created_at
                     ) VALUES (?, ?, ?, ?, 'binding_approval', ?, 'pending', ?)`,
                    )
                    .bind(
                        outboxId,
                        access.botId,
                        bindingId,
                        runtime.runtime_id,
                        encodeBotExecutionBindingApprovalRequest(request),
                        now,
                    ),
                this.audit(
                    access.scope,
                    access.botId,
                    "owner",
                    access.credentialId,
                    "bot.binding.requested",
                    bindingId,
                    { bindingRevision: bindingRevision.toString(), runtimeId: runtime.runtime_id },
                    now,
                ),
            ])
            .catch((cause: unknown) => {
                signal.throwIfAborted();
                throw new BotApiError("revision_conflict", "The Bot binding could not be requested", 409, { cause });
            });
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The Bot binding could not be requested", 409);
        }
        return new CreatedBindingRequest(
            bindingId,
            bindingRevision,
            new VerifiedChannelAccess(runtime.channel_id, runtime.runtime_id, runtime.tenant_id, runtime.project_id),
        );
    };

    readonly listPendingControl = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT payload FROM bot_control_outbox AS outbox
                   INNER JOIN bots ON bots.bot_id = outbox.bot_id
                  WHERE bots.tenant_id = ? AND bots.project_id = ?
                    AND outbox.runtime_id = ? AND outbox.state = 'pending'
                    AND outbox.message_kind = 'binding_approval'
                  ORDER BY outbox.created_at, outbox.outbox_id LIMIT ?`,
            )
            .bind(scope.tenantId, scope.projectId, runtimeId, Math.min(Math.max(limit, 1), 100))
            .all<{ readonly payload: string }>();
        signal.throwIfAborted();
        return rows.results.map((row) => row.payload);
    };

    readonly approveBinding = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingApprovedEvent,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (await this.isApprovedBindingReplay(scope, runtimeId, event, signal)) {
            return;
        }
        const binding = await this.matchBindingEvent(scope, runtimeId, event, signal);
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_behavior_revisions
                        SET lifecycle = 'retired', retired_at = ?
                      WHERE bot_id = ? AND lifecycle = 'approved' AND behavior_revision_id <> ?`,
                )
                .bind(now, binding.bot_id, binding.behavior_revision_id),
            this.#database
                .prepare(
                    `UPDATE bot_execution_bindings
                        SET lifecycle = 'approved', local_grant_id = ?,
                            agent_identity_digest = ?, workspace_identity_digest = ?,
                            approved_at = ?
                      WHERE binding_id = ? AND bot_id = ? AND lifecycle = 'requested'`,
                )
                .bind(
                    event.localGrantId,
                    event.agentIdentityDigest,
                    event.workspaceIdentityDigest,
                    now,
                    binding.binding_id,
                    binding.bot_id,
                ),
            this.#database
                .prepare(
                    `UPDATE bot_behavior_revisions
                        SET lifecycle = 'approved', approved_at = ?
                      WHERE behavior_revision_id = ? AND bot_id = ?
                        AND lifecycle = 'awaiting_local_approval'`,
                )
                .bind(now, binding.behavior_revision_id, binding.bot_id),
            this.#database
                .prepare(
                    `UPDATE bots SET
                        active_behavior_revision_id = ?, active_binding_id = ?,
                        lifecycle = CASE WHEN lifecycle = 'suspended' THEN 'suspended' ELSE 'active' END,
                        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
                      WHERE bot_id = ? AND lifecycle <> 'archived'`,
                )
                .bind(binding.behavior_revision_id, binding.binding_id, now, binding.bot_id),
            this.#database
                .prepare(
                    `UPDATE bot_control_outbox SET state = 'completed', completed_at = ?
                      WHERE subject_id = ? AND message_kind = 'binding_approval' AND state = 'pending'`,
                )
                .bind(now, binding.binding_id),
            this.audit(
                scope,
                binding.bot_id,
                "runtime",
                runtimeId,
                "bot.binding.approved",
                binding.binding_id,
                { localGrantId: event.localGrantId },
                now,
            ),
        ]);
        signal.throwIfAborted();
        const critical = results.slice(1);
        if (critical.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The Bot binding approval conflicted", 409);
        }
    };

    readonly rejectBinding = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingUnavailableEvent,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (await this.isUnavailableBindingReplay(scope, runtimeId, event, signal)) {
            return;
        }
        const binding = await this.matchBindingEvent(scope, runtimeId, event, signal);
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_execution_bindings
                        SET lifecycle = 'unavailable', unavailable_at = ?,
                            unavailable_code = ?, unavailable_message = ?
                      WHERE binding_id = ? AND bot_id = ? AND lifecycle = 'requested'`,
                )
                .bind(now, event.code, event.message, binding.binding_id, binding.bot_id),
            this.#database
                .prepare(
                    `UPDATE bot_behavior_revisions SET lifecycle = 'proposed'
                      WHERE behavior_revision_id = ? AND bot_id = ?
                        AND lifecycle = 'awaiting_local_approval'`,
                )
                .bind(binding.behavior_revision_id, binding.bot_id),
            this.#database
                .prepare(
                    `UPDATE bot_control_outbox SET state = 'failed', completed_at = ?
                      WHERE subject_id = ? AND message_kind = 'binding_approval' AND state = 'pending'`,
                )
                .bind(now, binding.binding_id),
            this.audit(
                scope,
                binding.bot_id,
                "runtime",
                runtimeId,
                "bot.binding.unavailable",
                binding.binding_id,
                { code: event.code },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The Bot binding response conflicted", 409);
        }
    };

    readonly readBot = async (access: BotOwnerAccess, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT bots.*, profiles.display_name, profiles.avatar_ref,
                        profiles.description, profiles.revision_number AS profile_revision_number
                   FROM bots
                   INNER JOIN bot_profile_revisions AS profiles
                     ON profiles.profile_revision_id = bots.current_profile_revision_id
                  WHERE bots.bot_id = ? AND bots.tenant_id = ? AND bots.project_id = ?`,
            )
            .bind(access.botId, access.scope.tenantId, access.scope.projectId)
            .first<BotProfileRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", 404);
        }
        return botResource(row);
    };

    readonly readApprovedBinding = async (botId: string, signal: AbortSignal): Promise<ApprovedBindingContext> => {
        signal.throwIfAborted();
        const binding = await this.#database
            .prepare(
                `SELECT bindings.*
                   FROM bots
                   INNER JOIN bot_execution_bindings AS bindings
                     ON bindings.binding_id = bots.active_binding_id
                  WHERE bots.bot_id = ? AND bots.lifecycle = 'active'
                    AND bindings.lifecycle = 'approved'`,
            )
            .bind(validateIdentifier(botId, "bot_id"))
            .first<BindingRow>();
        signal.throwIfAborted();
        if (binding === null) {
            const bot = await this.botRow(botId, signal);
            if (bot.lifecycle === "suspended") {
                throw new BotApiError("bot_suspended", "The Bot is suspended", 409);
            }
            throw new BotApiError("binding_not_approved", "The Bot has no approved binding", 409);
        }
        const behavior = await this.#database
            .prepare(`SELECT * FROM bot_behavior_revisions WHERE behavior_revision_id = ? AND bot_id = ?`)
            .bind(binding.behavior_revision_id, binding.bot_id)
            .first<BehaviorRow>();
        if (behavior === null || behavior.lifecycle !== "approved") {
            throw new BotApiError("behavior_not_approved", "The Bot behavior is not approved", 409);
        }
        const targets = await this.targets(
            binding.bot_id,
            stringArray(binding.allowed_delivery_target_ids_json, "The binding targets are invalid"),
            signal,
        );
        return new ApprovedBindingContext(binding, behavior, targets, completionPolicy(binding.completion_policy_json));
    };

    readonly readRuntimeAccess = async (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<VerifiedChannelAccess> => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT channel_id, runtime_id, tenant_id, project_id, agents_json
                   FROM pairing_channels
                  WHERE tenant_id = ? AND project_id = ? AND runtime_id = ? AND status = 'paired'`,
            )
            .bind(scope.tenantId, scope.projectId, validateIdentifier(runtimeId, "runtime_id"))
            .first<RuntimeRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("binding_incompatible", "The approved Runtime is unavailable", 409);
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    readonly transitionBot = async (
        access: BotOwnerAccess,
        expectedRevision: number,
        action: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const bot = await this.botRow(access.botId, signal);
        if (bot.lifecycle_revision !== expectedRevision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", 409);
        }
        let lifecycle: string;
        if (action === "suspend") {
            if (bot.lifecycle !== "active") {
                throw new BotApiError("bot_not_active", "Only an active Bot can be suspended", 409);
            }
            lifecycle = "suspended";
        } else if (action === "archive") {
            if (bot.lifecycle === "archived") {
                throw new BotApiError("bot_not_active", "The Bot is already archived", 409);
            }
            lifecycle = "archived";
        } else {
            throw new BotApiError("invalid_request", "The Bot lifecycle action is invalid", 400);
        }
        const timeColumn = lifecycle === "suspended" ? "suspended_at" : "archived_at";
        const nextRevision = expectedRevision + 1;
        const actionName = lifecycle === "suspended" ? "bot.suspended" : "bot.archived";
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bots SET lifecycle = ?, lifecycle_revision = lifecycle_revision + 1,
                        updated_at = ?, ${timeColumn} = ?
                      WHERE bot_id = ? AND lifecycle_revision = ?`,
                )
                .bind(lifecycle, now, now, access.botId, expectedRevision),
            this.#database
                .prepare(
                    `INSERT INTO bot_audit_events (
                       audit_id, tenant_id, project_id, bot_id, actor_kind,
                       actor_id, action, subject_id, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?
                      WHERE EXISTS (
                        SELECT 1 FROM bots
                         WHERE bot_id = ? AND lifecycle = ? AND lifecycle_revision = ?
                      )
                        AND NOT EXISTS (
                          SELECT 1 FROM bot_audit_events
                           WHERE bot_id = ? AND action = ? AND subject_id = ?
                        )`,
                )
                .bind(
                    `aud_${createRandomToken(18)}`,
                    access.scope.tenantId,
                    access.scope.projectId,
                    access.botId,
                    access.credentialId,
                    actionName,
                    access.botId,
                    JSON.stringify({ lifecycleRevision: nextRevision.toString() }),
                    now,
                    access.botId,
                    lifecycle,
                    nextRevision,
                    access.botId,
                    actionName,
                    access.botId,
                ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", 409);
        }
        return await this.readBot(access, signal);
    };

    private readonly botRow = async (botId: string, signal: AbortSignal): Promise<BotRow> => {
        const row = await this.#database
            .prepare(`SELECT * FROM bots WHERE bot_id = ?`)
            .bind(validateIdentifier(botId, "bot_id"))
            .first<BotRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", 404);
        }
        return row;
    };

    private readonly targets = async (
        botId: string,
        identifiers: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly BotDeliveryTargetReference[]> => {
        const targets: BotDeliveryTargetReference[] = [];
        const unique = new Set<string>();
        for (const identifier of identifiers) {
            const normalized = validateIdentifier(identifier, "delivery_target_id");
            if (unique.has(normalized)) {
                throw new BotApiError("invalid_request", "Delivery targets must be unique", 400);
            }
            unique.add(normalized);
            const target = await this.#database
                .prepare(
                    `SELECT targets.delivery_target_id, targets.bot_id, targets.alias,
                            targets.lifecycle, targets.owner_approved,
                            connections.lifecycle AS connection_lifecycle
                       FROM bot_delivery_targets AS targets
                       INNER JOIN bot_connections AS connections
                         ON connections.connection_id = targets.connection_id
                      WHERE targets.delivery_target_id = ?`,
                )
                .bind(normalized)
                .first<TargetRow>();
            signal.throwIfAborted();
            if (
                target === null ||
                target.bot_id !== botId ||
                target.lifecycle !== "active" ||
                target.connection_lifecycle !== "active" ||
                target.owner_approved !== 1
            ) {
                throw new BotApiError(
                    "delivery_target_not_allowed",
                    "The delivery target is not approved for this Bot",
                    403,
                );
            }
            targets.push(new BotDeliveryTargetReference(target.alias, target.delivery_target_id));
        }
        return targets;
    };

    private readonly matchBindingEvent = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BindingEventIdentity,
        signal: AbortSignal,
    ): Promise<BindingRow> => {
        const binding = await this.#database
            .prepare(
                `SELECT bindings.*
                   FROM bot_execution_bindings AS bindings
                   INNER JOIN bots ON bots.bot_id = bindings.bot_id
                   INNER JOIN bot_control_outbox AS outbox
                     ON outbox.subject_id = bindings.binding_id
                  WHERE bindings.binding_id = ? AND bindings.bot_id = ?
                    AND bindings.behavior_revision_id = ?
                    AND bindings.binding_revision = ? AND bindings.runtime_id = ?
                    AND bindings.lifecycle = 'requested'
                    AND bots.tenant_id = ? AND bots.project_id = ?
                    AND outbox.state = 'pending'
                    AND outbox.message_kind = 'binding_approval'
                    AND json_extract(outbox.payload, '$.requestId') = ?`,
            )
            .bind(
                event.bindingId,
                event.botId,
                event.behaviorRevisionId,
                event.bindingRevision,
                runtimeId,
                scope.tenantId,
                scope.projectId,
                event.requestId,
            )
            .first<BindingRow>();
        signal.throwIfAborted();
        if (binding === null) {
            throw new BotApiError("revision_conflict", "The Bot binding response is stale", 409);
        }
        return binding;
    };

    private readonly isApprovedBindingReplay = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingApprovedEvent,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const replay = await this.#database
            .prepare(
                `SELECT 1 AS replay
                   FROM bot_execution_bindings AS bindings
                   INNER JOIN bots ON bots.bot_id = bindings.bot_id
                   INNER JOIN bot_control_outbox AS outbox
                     ON outbox.subject_id = bindings.binding_id
                  WHERE bindings.binding_id = ? AND bindings.bot_id = ?
                    AND bindings.behavior_revision_id = ?
                    AND bindings.binding_revision = ? AND bindings.runtime_id = ?
                    AND bindings.lifecycle = 'approved'
                    AND bindings.local_grant_id = ?
                    AND bindings.agent_identity_digest = ?
                    AND bindings.workspace_identity_digest = ?
                    AND bots.tenant_id = ? AND bots.project_id = ?
                    AND outbox.state = 'completed'
                    AND outbox.message_kind = 'binding_approval'
                    AND json_extract(outbox.payload, '$.requestId') = ?`,
            )
            .bind(
                event.bindingId,
                event.botId,
                event.behaviorRevisionId,
                event.bindingRevision,
                runtimeId,
                event.localGrantId,
                event.agentIdentityDigest,
                event.workspaceIdentityDigest,
                scope.tenantId,
                scope.projectId,
                event.requestId,
            )
            .first<{ readonly replay: number }>();
        signal.throwIfAborted();
        return replay?.replay === 1;
    };

    private readonly isUnavailableBindingReplay = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingUnavailableEvent,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const replay = await this.#database
            .prepare(
                `SELECT 1 AS replay
                   FROM bot_execution_bindings AS bindings
                   INNER JOIN bots ON bots.bot_id = bindings.bot_id
                   INNER JOIN bot_control_outbox AS outbox
                     ON outbox.subject_id = bindings.binding_id
                  WHERE bindings.binding_id = ? AND bindings.bot_id = ?
                    AND bindings.behavior_revision_id = ?
                    AND bindings.binding_revision = ? AND bindings.runtime_id = ?
                    AND bindings.lifecycle = 'unavailable'
                    AND bindings.unavailable_code = ?
                    AND bindings.unavailable_message = ?
                    AND bots.tenant_id = ? AND bots.project_id = ?
                    AND outbox.state = 'failed'
                    AND outbox.message_kind = 'binding_approval'
                    AND json_extract(outbox.payload, '$.requestId') = ?`,
            )
            .bind(
                event.bindingId,
                event.botId,
                event.behaviorRevisionId,
                event.bindingRevision,
                runtimeId,
                event.code,
                event.message,
                scope.tenantId,
                scope.projectId,
                event.requestId,
            )
            .first<{ readonly replay: number }>();
        signal.throwIfAborted();
        return replay?.replay === 1;
    };

    private readonly audit = (
        scope: ProjectScope,
        botId: string,
        actorKind: string,
        actorId: string,
        action: string,
        subjectId: string,
        details: Readonly<Record<string, string>>,
        now: number,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO bot_audit_events (
                   audit_id, tenant_id, project_id, bot_id, actor_kind,
                   actor_id, action, subject_id, details_json, recorded_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE changes() = 1`,
            )
            .bind(
                `aud_${createRandomToken(18)}`,
                scope.tenantId,
                scope.projectId,
                botId,
                actorKind,
                actorId,
                action,
                subjectId,
                JSON.stringify(details),
                now,
            );
}
