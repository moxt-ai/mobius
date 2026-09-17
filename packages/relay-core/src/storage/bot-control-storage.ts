import type { ProjectAccessContext } from "../entity/authentication/project-authentication.ts";
import type { ProjectBotAccess } from "../entity/bot/bot-access.ts";
import type { BotExecutionBindingActivation } from "../entity/bot/bot-binding.ts";
import type { BotBehaviorRevision, BotProfileRevision } from "../entity/bot/bot-revisions.ts";
import type { ProjectScope } from "../entity/do/session.ts";
import { createRandomToken, validateIdentifier } from "../entity/pairing/pairing.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import type { SqlDatabase, SqlStatement } from "../infra/sql-database.ts";

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
    readonly updated_at: number;
}

interface BehaviorRow {
    readonly activated_at: unknown;
    readonly retired_at: unknown;
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
    readonly activated_at: unknown;
    readonly revoked_at: unknown;
    readonly unavailable_at: unknown;
    readonly unavailable_code: unknown;
    readonly unavailable_message: unknown;
    readonly agent_config_revision: number;
    readonly agent_ref: string;
    readonly allowed_delivery_target_ids_json: string;
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly completion_policy_json: string;
    readonly created_at: number;
    readonly execution_configuration_json: string;
    readonly lifecycle: string;
    readonly runtime_id: string;
    readonly workspace_ref: string;
}

interface ActiveConversationExecutionRow extends BindingRow {
    readonly behavior_agent_configuration_json: string;
    readonly behavior_content_digest: string;
    readonly behavior_instructions: string;
    readonly paired_runtime_id: string;
}

interface BotProfileRow extends BotRow {
    readonly avatar_ref: string;
    readonly description: string;
    readonly display_name: string;
    readonly profile_revision_number: number;
}

export class BotControlStorage {
    readonly #database: SqlDatabase;

    constructor(project: ProjectStorageContext, databases: DatabaseResolver) {
        this.#database = databases.resolve(project.storagePlacement);
    }

    readonly listBots = async (access: ProjectAccessContext, signal: AbortSignal) => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(`SELECT bots.*, profiles.display_name, profiles.avatar_ref,
                    profiles.description, profiles.revision_number AS profile_revision_number
                FROM bots INNER JOIN bot_profile_revisions AS profiles
                  ON profiles.profile_revision_id = bots.current_profile_revision_id
                WHERE bots.project_id = ?
                ORDER BY bots.updated_at DESC, bots.bot_id DESC`)
            .bind(access.scope.projectId)
            .all<BotProfileRow>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly listBehaviorRevisions = async (access: ProjectBotAccess, signal: AbortSignal) => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(`SELECT behaviors.* FROM bot_behavior_revisions AS behaviors
                INNER JOIN bots ON bots.bot_id = behaviors.bot_id
                WHERE behaviors.bot_id = ? AND bots.project_id = ?
                ORDER BY behaviors.revision_number DESC`)
            .bind(access.botId, access.scope.projectId)
            .all<BehaviorRow>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly listExecutionBindings = async (access: ProjectBotAccess, signal: AbortSignal) => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(`SELECT bindings.* FROM bot_execution_bindings AS bindings
                INNER JOIN bots ON bots.bot_id = bindings.bot_id
                WHERE bindings.bot_id = ? AND bots.project_id = ?
                ORDER BY bindings.binding_revision DESC`)
            .bind(access.botId, access.scope.projectId)
            .all<BindingRow>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly listProjectBots = async (projectId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT b.bot_id AS botId, p.display_name AS displayName, b.lifecycle,
                  COALESCE((SELECT lifecycle FROM bot_execution_bindings WHERE bot_id = b.bot_id ORDER BY binding_revision DESC LIMIT 1), 'not-configured') AS setupStatus
               FROM bots b JOIN bot_profile_revisions p ON p.profile_revision_id = b.current_profile_revision_id
                WHERE b.project_id = ? ORDER BY b.created_at, b.bot_id`,
            )
            .bind(projectId)
            .all<{
                readonly botId: string;
                readonly displayName: string;
                readonly lifecycle: string;
                readonly setupStatus: string;
            }>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly writeBot = async (
        access: ProjectAccessContext,
        profile: BotProfileRevision,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const { botId, profileRevisionId, displayName, avatarRef, description } = profile;
        const results = await this.#database.batch(
            [
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
                       bot_id, project_id, current_profile_revision_id,
                       lifecycle, lifecycle_revision, created_at, updated_at
                     ) VALUES (?, ?, ?, 'draft', 1, ?, ?)`,
                    )
                    .bind(botId, access.scope.projectId, profileRevisionId, now, now),
                this.audit(
                    access.scope,
                    botId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.created",
                    botId,
                    {},
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readLatestProfileRevision = async (botId: string, signal: AbortSignal) => {
        const revisionRow = await this.#database
            .prepare(`SELECT COALESCE(MAX(revision_number), 0) AS revision FROM bot_profile_revisions WHERE bot_id = ?`)
            .bind(botId)
            .first<{ readonly revision: number }>(signal);
        signal.throwIfAborted();
        return revisionRow?.revision ?? 0;
    };

    readonly writeProfileRevision = async (
        access: ProjectBotAccess,
        expectedRevision: number,
        profile: BotProfileRevision,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const {
            profileRevisionId,
            revisionNumber: revision,
            lifecycleRevision: nextLifecycleRevision,
            displayName,
            avatarRef,
            description,
        } = profile;
        const results = await this.#database.batch(
            [
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
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.profile.revised",
                    profileRevisionId,
                    { revision: revision.toString() },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readLatestBehaviorRevision = async (botId: string, signal: AbortSignal) => {
        const current = await this.#database
            .prepare(
                `SELECT COALESCE(MAX(revision_number), 0) AS revision FROM bot_behavior_revisions WHERE bot_id = ?`,
            )
            .bind(botId)
            .first<{ readonly revision: number }>(signal);
        signal.throwIfAborted();
        return current?.revision ?? 0;
    };

    readonly writeBehaviorRevision = async (
        access: ProjectBotAccess,
        behavior: BotBehaviorRevision,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const {
            behaviorRevisionId,
            revisionNumber,
            instructions,
            requiredCapabilities,
            agentConfiguration,
            contentDigest,
        } = behavior;
        const normalizedConfiguration = JSON.stringify(agentConfiguration);
        const normalizedCapabilities = JSON.stringify([...requiredCapabilities].sort());
        signal.throwIfAborted();
        const results = await this.#database.batch(
            [
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
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.behavior.proposed",
                    behaviorRevisionId,
                    { revision: revisionNumber.toString() },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readBehavior = async (botId: string, behaviorRevisionId: string, signal: AbortSignal) => {
        const behavior = await this.#database
            .prepare(`SELECT * FROM bot_behavior_revisions WHERE bot_id = ? AND behavior_revision_id = ?`)
            .bind(botId, behaviorRevisionId)
            .first<BehaviorRow>(signal);
        signal.throwIfAborted();
        return behavior;
    };

    readonly readBindingRuntime = async (scope: ProjectScope, runtimeId: string, signal: AbortSignal) => {
        const runtime = await this.#database
            .prepare(
                `SELECT channel_id, runtime_id, project_id, agents_json
                   FROM pairing_channels
                  WHERE runtime_id = ? AND project_id = ? AND status = 'paired'`,
            )
            .bind(runtimeId, scope.projectId)
            .first<RuntimeRow>(signal);
        signal.throwIfAborted();
        return runtime;
    };

    readonly readLatestBindingRevision = async (botId: string, signal: AbortSignal) => {
        const revisionRow = await this.#database
            .prepare(
                `SELECT COALESCE(MAX(binding_revision), 0) AS revision FROM bot_execution_bindings WHERE bot_id = ?`,
            )
            .bind(botId)
            .first<{ readonly revision: number }>(signal);
        signal.throwIfAborted();
        return revisionRow?.revision ?? 0;
    };

    readonly writeBinding = async (
        access: ProjectBotAccess,
        request: BotExecutionBindingActivation,
        allowedDeliveryTargetIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const {
            bindingId,
            bindingRevision,
            behaviorRevisionId,
            runtimeId,
            agentRef,
            workspaceRef,
            agentConfigRevision,
            completionPolicy,
            executionConfiguration,
        } = request;
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bot_behavior_revisions
                            SET lifecycle = 'retired', retired_at = ?
                          WHERE bot_id = ? AND lifecycle = 'active'
                            AND behavior_revision_id <> ?`,
                    )
                    .bind(now, access.botId, behaviorRevisionId),
                this.#database
                    .prepare(
                        `INSERT INTO bot_execution_bindings (
                       binding_id, bot_id, behavior_revision_id, binding_revision,
                       runtime_id, agent_ref, workspace_ref, agent_config_revision,
                       allowed_delivery_target_ids_json, completion_policy_json, execution_configuration_json,
                       lifecycle, created_at, activated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                    )
                    .bind(
                        bindingId,
                        access.botId,
                        behaviorRevisionId,
                        bindingRevision,
                        runtimeId,
                        agentRef,
                        workspaceRef,
                        agentConfigRevision,
                        JSON.stringify(allowedDeliveryTargetIds),
                        JSON.stringify(completionPolicy),
                        JSON.stringify(executionConfiguration),
                        now,
                        now,
                    ),
                this.#database
                    .prepare(
                        `UPDATE bot_behavior_revisions
                            SET lifecycle = 'active', activated_at = ?
                      WHERE behavior_revision_id = ? AND bot_id = ?
                        AND lifecycle = 'proposed'`,
                    )
                    .bind(now, behaviorRevisionId, access.botId),
                this.#database
                    .prepare(
                        `UPDATE bots SET
                            active_behavior_revision_id = ?, active_binding_id = ?,
                            lifecycle = CASE WHEN lifecycle = 'suspended' THEN 'suspended' ELSE 'active' END,
                            lifecycle_revision = lifecycle_revision + 1, updated_at = ?
                          WHERE bot_id = ? AND lifecycle <> 'archived'`,
                    )
                    .bind(behaviorRevisionId, bindingId, now, access.botId),
                this.audit(
                    access.scope,
                    access.botId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.binding.activated",
                    bindingId,
                    { bindingRevision: bindingRevision.toString(), runtimeId },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.slice(1).every((result) => result.meta.changes === 1);
    };

    readonly readDeliveryTarget = async (targetId: string, signal: AbortSignal) => {
        const target = await this.#database
            .prepare(`SELECT targets.delivery_target_id, targets.bot_id, targets.alias,
            targets.lifecycle, targets.owner_approved, connections.lifecycle AS connection_lifecycle
            FROM bot_delivery_targets AS targets
            INNER JOIN bot_connections AS connections ON connections.connection_id = targets.connection_id
            WHERE targets.delivery_target_id = ?`)
            .bind(targetId)
            .first<TargetRow>(signal);
        signal.throwIfAborted();
        return target;
    };

    readonly readBot = async (access: ProjectBotAccess, signal: AbortSignal) => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT bots.*, profiles.display_name, profiles.avatar_ref,
                        profiles.description, profiles.revision_number AS profile_revision_number
                   FROM bots
                   INNER JOIN bot_profile_revisions AS profiles
                     ON profiles.profile_revision_id = bots.current_profile_revision_id
                  WHERE bots.bot_id = ? AND bots.project_id = ?`,
            )
            .bind(access.botId, access.scope.projectId)
            .first<BotProfileRow>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readSetup = async (access: ProjectBotAccess, signal: AbortSignal) => {
        const bot = await this.botRow(access.botId, signal);
        const behavior = await this.#database
            .prepare(
                `SELECT COALESCE(MAX(revision_number), 0) AS revision FROM bot_behavior_revisions WHERE bot_id = ?`,
            )
            .bind(access.botId)
            .first<{ readonly revision: number }>(signal);
        signal.throwIfAborted();
        const binding = await this.#database
            .prepare(
                `SELECT bindings.*, behaviors.instructions FROM bot_execution_bindings bindings JOIN bot_behavior_revisions behaviors ON behaviors.behavior_revision_id = bindings.behavior_revision_id WHERE bindings.bot_id = ? ORDER BY bindings.binding_revision DESC LIMIT 1`,
            )
            .bind(access.botId)
            .first<BindingRow & { readonly instructions: string }>(signal);
        signal.throwIfAborted();
        return { bot, behavior, binding };
    };

    readonly readActiveBinding = async (botId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const binding = await this.#database
            .prepare(
                `SELECT bindings.*
                   FROM bots
                   INNER JOIN bot_execution_bindings AS bindings
                     ON bindings.binding_id = bots.active_binding_id
                  WHERE bots.bot_id = ? AND bots.lifecycle = 'active'
                    AND bindings.lifecycle = 'active'`,
            )
            .bind(validateIdentifier(botId, "bot_id"))
            .first<BindingRow>(signal);
        signal.throwIfAborted();
        return binding;
    };

    readonly readActiveConversationExecution = async (scope: ProjectScope, botId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const execution = await this.#database
            .prepare(
                `SELECT bindings.*,
                        behaviors.agent_configuration_json AS behavior_agent_configuration_json,
                        behaviors.content_digest AS behavior_content_digest,
                        behaviors.instructions AS behavior_instructions,
                        runtimes.runtime_id AS paired_runtime_id
                   FROM bots
                   INNER JOIN bot_execution_bindings AS bindings
                     ON bindings.binding_id = bots.active_binding_id
                    AND bindings.lifecycle = 'active'
                   INNER JOIN bot_behavior_revisions AS behaviors
                     ON behaviors.behavior_revision_id = bindings.behavior_revision_id
                    AND behaviors.bot_id = bindings.bot_id
                    AND behaviors.lifecycle = 'active'
                   INNER JOIN pairing_channels AS runtimes
                     ON runtimes.runtime_id = bindings.runtime_id
                    AND runtimes.project_id = bots.project_id
                    AND runtimes.status = 'paired'
                  WHERE bots.bot_id = ? AND bots.project_id = ? AND bots.lifecycle = 'active'`,
            )
            .bind(validateIdentifier(botId, "bot_id"), scope.projectId)
            .first<ActiveConversationExecutionRow>(signal);
        signal.throwIfAborted();
        return execution;
    };

    readonly readRuntime = async (scope: ProjectScope, runtimeId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT channel_id, runtime_id, project_id, agents_json
                   FROM pairing_channels
                  WHERE project_id = ? AND runtime_id = ? AND status = 'paired'`,
            )
            .bind(scope.projectId, validateIdentifier(runtimeId, "runtime_id"))
            .first<RuntimeRow>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readLifecycle = async (botId: string, signal: AbortSignal) => {
        const bot = await this.botRow(botId, signal);
        return bot === null
            ? null
            : {
                  lifecycle: bot.lifecycle,
                  revision: bot.lifecycle_revision,
                  activeBehaviorRevisionId: bot.active_behavior_revision_id,
                  activeBindingId: bot.active_binding_id,
              };
    };

    readonly writeLifecycle = async (
        access: ProjectBotAccess,
        expectedRevision: number,
        lifecycle: "active" | "suspended" | "archived",
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const timeColumn = lifecycle === "archived" ? "archived_at" : "suspended_at";
        const nextRevision = expectedRevision + 1;
        const actionName =
            lifecycle === "active" ? "bot.resumed" : lifecycle === "suspended" ? "bot.suspended" : "bot.archived";
        const auditSubjectId = `${access.botId}:${nextRevision.toString()}`;
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bots SET lifecycle = ?, lifecycle_revision = lifecycle_revision + 1,
                        updated_at = ?, ${timeColumn} = ?
                      WHERE bot_id = ? AND lifecycle_revision = ?`,
                    )
                    .bind(lifecycle, now, lifecycle === "active" ? null : now, access.botId, expectedRevision),
                this.#database
                    .prepare(
                        `INSERT INTO bot_audit_events (
                       audit_id, project_id, bot_id, actor_kind,
                       actor_id, action, subject_id, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
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
                        access.scope.projectId,
                        access.botId,
                        access.actor.kind.value,
                        access.actor.actorId,
                        actionName,
                        auditSubjectId,
                        JSON.stringify({ lifecycleRevision: nextRevision.toString() }),
                        now,
                        access.botId,
                        lifecycle,
                        nextRevision,
                        access.botId,
                        actionName,
                        auditSubjectId,
                    ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    private readonly botRow = async (botId: string, signal: AbortSignal): Promise<BotRow | null> => {
        const row = await this.#database
            .prepare(`SELECT * FROM bots WHERE bot_id = ?`)
            .bind(validateIdentifier(botId, "bot_id"))
            .first<BotRow>(signal);
        signal.throwIfAborted();
        return row;
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
    ): SqlStatement =>
        this.#database
            .prepare(
                `INSERT INTO bot_audit_events (
                   audit_id, project_id, bot_id, actor_kind,
                   actor_id, action, subject_id, details_json, recorded_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE changes() = 1`,
            )
            .bind(
                `aud_${createRandomToken(18)}`,
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
