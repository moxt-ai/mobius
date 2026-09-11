import type { BotConnectionAccess, ProjectBotAccess } from "../entity/bot/bot-access.ts";
import type { BotGrantCredential } from "../entity/bot/bot-grant.ts";
import { ProjectScope } from "../entity/do/session.ts";
import { createRandomToken, validateIdentifier } from "../entity/pairing/pairing.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import type { SqlDatabase, SqlStatement } from "../infra/sql-database.ts";

interface TargetRow {
    readonly alias: string;
    readonly bot_id: string;
    readonly connection_id: string;
    readonly connection_lifecycle: string;
    readonly delivery_target_id: string;
    readonly lifecycle: string;
    readonly outbound_policy_revision: number;
    readonly owner_approved: number;
}

interface ConnectionListRow {
    readonly audience: string;
    readonly bot_id: string;
    readonly connection_id: string;
    readonly connector_principal_id: string;
    readonly created_at: number;
    readonly label: string;
    readonly last_used_at: number;
    readonly lifecycle: string;
    readonly lifecycle_revision: number;
    readonly revoked_at: unknown;
    readonly scopes_json: string;
}

interface TargetListRow extends TargetRow {
    readonly created_at: number;
    readonly disabled_at: unknown;
    readonly lifecycle_revision: number;
    readonly updated_at: number;
}

export class BotConnectionStorage {
    readonly #database: SqlDatabase;

    constructor(project: ProjectStorageContext, databases: DatabaseResolver) {
        this.#database = databases.resolve(project.storagePlacement);
    }

    readonly listForProject = async (access: ProjectBotAccess, signal: AbortSignal) => {
        signal.throwIfAborted();
        const [connections, targets] = await Promise.all([
            this.#database
                .prepare(`SELECT connections.* FROM bot_connections AS connections
                    INNER JOIN bots ON bots.bot_id = connections.bot_id
                    WHERE connections.bot_id = ? AND bots.project_id = ?
                    ORDER BY connections.created_at DESC, connections.connection_id DESC`)
                .bind(access.botId, access.scope.projectId)
                .all<ConnectionListRow>(signal),
            this.#database
                .prepare(`SELECT targets.*, connections.lifecycle AS connection_lifecycle
                    FROM bot_delivery_targets AS targets INNER JOIN bot_connections AS connections
                      ON connections.connection_id = targets.connection_id
                    INNER JOIN bots ON bots.bot_id = targets.bot_id
                    WHERE targets.bot_id = ? AND bots.project_id = ?
                    ORDER BY targets.created_at DESC, targets.delivery_target_id DESC`)
                .bind(access.botId, access.scope.projectId)
                .all<TargetListRow>(signal),
        ]);
        signal.throwIfAborted();
        return { connections: connections.results, deliveryTargets: targets.results };
    };

    readonly writeGrant = async (
        access: ProjectBotAccess,
        grant: {
            readonly grantId: string;
            readonly secretDigest: string;
            readonly audience: string;
            readonly label: string;
            readonly scopes: readonly string[];
            readonly expiresAt: number;
        },
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const { grantId, secretDigest, audience, label, scopes, expiresAt } = grant;
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `INSERT INTO bot_connection_grants (
                       grant_id, bot_id, audience, label, scopes_json, secret_digest,
                       created_at, expires_at
                     )
                     SELECT ?, bot_id, ?, ?, ?, ?, ?, ?
                       FROM bots
                      WHERE bot_id = ? AND lifecycle <> 'archived'`,
                    )
                    .bind(grantId, audience, label, JSON.stringify(scopes), secretDigest, now, expiresAt, access.botId),
                this.audit(
                    access.scope,
                    access.botId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.connection_grant.created",
                    grantId,
                    { audience, label },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readProjectConnection = async (access: ProjectBotAccess, connectionId: string, signal: AbortSignal) => {
        const row = await this.#database
            .prepare(
                `SELECT connections.lifecycle, connections.lifecycle_revision
             FROM bot_connections AS connections INNER JOIN bots ON bots.bot_id = connections.bot_id
             WHERE connections.connection_id = ? AND connections.bot_id = ?
               AND bots.project_id = ?`,
            )
            .bind(connectionId, access.botId, access.scope.projectId)
            .first<{ readonly lifecycle: string; readonly lifecycle_revision: number }>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly writeOwnerRevocation = async (
        access: ProjectBotAccess,
        connectionId: string,
        expectedRevision: number,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bot_connections SET lifecycle = 'revoked', lifecycle_revision = ?, revoked_at = ?
                 WHERE connection_id = ? AND bot_id = ? AND lifecycle = 'active' AND lifecycle_revision = ?`,
                    )
                    .bind(expectedRevision + 1, now, connectionId, access.botId, expectedRevision),
                this.audit(
                    access.scope,
                    access.botId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.connection.revoked",
                    connectionId,
                    {},
                    now,
                ),
                this.#database
                    .prepare(
                        `UPDATE bot_connection_credentials SET revoked_at = COALESCE(revoked_at, ?)
                 WHERE connection_id = ? AND revoked_at IS NULL`,
                    )
                    .bind(now, connectionId),
                this.#database
                    .prepare(
                        `UPDATE bot_delivery_targets SET lifecycle = 'disabled', lifecycle_revision = lifecycle_revision + 1,
                 updated_at = ?, disabled_at = COALESCE(disabled_at, ?) WHERE connection_id = ? AND lifecycle = 'active'`,
                    )
                    .bind(now, now, connectionId),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
    };

    readonly writeGrantRedemption = async (
        grant: BotGrantCredential,
        redemption: {
            readonly grantId: string;
            readonly grantDigest: string;
            readonly audience: string;
            readonly connectorPrincipalId: string;
            readonly connectionId: string;
            readonly credentialId: string;
            readonly credentialDigest: string;
            readonly expiresAt: number;
        },
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const {
            grantId: normalizedGrantId,
            grantDigest,
            audience,
            connectorPrincipalId,
            connectionId,
            credentialId,
            credentialDigest,
            expiresAt,
        } = redemption;
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `INSERT INTO bot_connections (
                       connection_id, bot_id, connector_principal_id, audience,
                       label, scopes_json, lifecycle, lifecycle_revision,
                       created_at, last_used_at, source_grant_id
                     )
                     SELECT ?, bot_id, ?, audience, label, scopes_json,
                            'active', 1, ?, ?, grant_id
                       FROM bot_connection_grants
                      WHERE grant_id = ? AND secret_digest = ? AND audience = ?
                        AND consumed_at IS NULL AND expires_at > ?`,
                    )
                    .bind(connectionId, connectorPrincipalId, now, now, normalizedGrantId, grantDigest, audience, now),
                this.#database
                    .prepare(
                        `INSERT INTO bot_connection_credentials (
                       credential_id, connection_id, secret_digest,
                       issued_at, expires_at, last_used_at
                     )
                     SELECT ?, connection_id, ?, ?, ?, ?
                       FROM bot_connections
                      WHERE connection_id = ? AND source_grant_id = ?`,
                    )
                    .bind(credentialId, credentialDigest, now, expiresAt, now, connectionId, normalizedGrantId),
                this.#database
                    .prepare(
                        `UPDATE bot_connection_grants
                        SET consumed_at = ?, consumed_connection_id = ?
                      WHERE grant_id = ? AND secret_digest = ? AND audience = ?
                        AND consumed_at IS NULL AND expires_at > ?`,
                    )
                    .bind(now, connectionId, normalizedGrantId, grantDigest, audience, now),
                this.audit(
                    new ProjectScope(grant.project_id),
                    grant.bot_id,
                    "connector",
                    connectorPrincipalId,
                    "bot.connection.created",
                    connectionId,
                    { grantId: normalizedGrantId },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly writeCredentialRotation = async (
        access: BotConnectionAccess,
        rotation: {
            readonly credentialId: string;
            readonly credentialDigest: string;
            readonly expiresAt: number;
            readonly oldExpiresAt: number;
        },
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const { credentialId, credentialDigest, expiresAt, oldExpiresAt } = rotation;
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `INSERT INTO bot_connection_credentials (
                       credential_id, connection_id, secret_digest,
                       issued_at, expires_at, last_used_at
                     )
                     SELECT ?, connections.connection_id, ?, ?, ?, ?
                       FROM bot_connections AS connections
                       INNER JOIN bot_connection_credentials AS credentials
                         ON credentials.connection_id = connections.connection_id
                      WHERE connections.connection_id = ?
                        AND connections.lifecycle = 'active'
                        AND credentials.credential_id = ?
                        AND credentials.revoked_at IS NULL
                        AND credentials.expires_at > ?
                        AND credentials.replaced_by_credential_id IS NULL`,
                    )
                    .bind(
                        credentialId,
                        credentialDigest,
                        now,
                        expiresAt,
                        now,
                        access.connectionId,
                        access.credentialId,
                        now,
                    ),
                this.#database
                    .prepare(
                        `UPDATE bot_connection_credentials
                        SET expires_at = MIN(expires_at, ?), replaced_by_credential_id = ?
                      WHERE credential_id = ? AND connection_id = ? AND revoked_at IS NULL
                        AND replaced_by_credential_id IS NULL
                        AND EXISTS (
                          SELECT 1 FROM bot_connection_credentials AS replacement
                           WHERE replacement.credential_id = ?
                             AND replacement.connection_id = ?
                        )`,
                    )
                    .bind(
                        oldExpiresAt,
                        credentialId,
                        access.credentialId,
                        access.connectionId,
                        credentialId,
                        access.connectionId,
                    ),
                this.audit(
                    access.scope,
                    access.botId,
                    "connector",
                    access.connectorPrincipalId,
                    "bot.connection_credential.rotated",
                    credentialId,
                    { connectionId: access.connectionId, replacedCredentialId: access.credentialId },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly writeConnectionRevocation = async (
        access: BotConnectionAccess,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bot_connections
                        SET lifecycle = 'revoked', lifecycle_revision = lifecycle_revision + 1,
                            revoked_at = COALESCE(revoked_at, ?)
                      WHERE connection_id = ? AND lifecycle = 'active'`,
                    )
                    .bind(now, access.connectionId),
                this.audit(
                    access.scope,
                    access.botId,
                    "connector",
                    access.connectorPrincipalId,
                    "bot.connection.revoked",
                    access.connectionId,
                    {},
                    now,
                ),
                this.#database
                    .prepare(
                        `UPDATE bot_connection_credentials SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE connection_id = ? AND revoked_at IS NULL`,
                    )
                    .bind(now, access.connectionId),
                this.#database
                    .prepare(
                        `UPDATE bot_delivery_targets SET lifecycle = 'disabled',
                        lifecycle_revision = lifecycle_revision + 1,
                        updated_at = ?, disabled_at = COALESCE(disabled_at, ?)
                      WHERE connection_id = ? AND lifecycle = 'active'`,
                    )
                    .bind(now, now, access.connectionId),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
    };

    readonly writeTarget = async (
        access: BotConnectionAccess,
        deliveryTargetId: string,
        alias: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `INSERT INTO bot_delivery_targets (
                           delivery_target_id, bot_id, connection_id, alias,
                           outbound_policy_revision, lifecycle, lifecycle_revision,
                           owner_approved, created_at, updated_at
                         ) VALUES (?, ?, ?, ?, 0, 'active', 1, 0, ?, ?)`,
                    )
                    .bind(deliveryTargetId, access.botId, access.connectionId, alias, now, now),
                this.audit(
                    access.scope,
                    access.botId,
                    "connector",
                    access.connectorPrincipalId,
                    "bot.delivery_target.created",
                    deliveryTargetId,
                    { alias },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly writeTargetApproval = async (
        access: ProjectBotAccess,
        deliveryTargetId: string,
        expectedPolicyRevision: number,
        nextRevision: number,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bot_delivery_targets
                        SET owner_approved = 1, outbound_policy_revision = ?, updated_at = ?
                      WHERE delivery_target_id = ? AND bot_id = ? AND lifecycle = 'active'
                        AND outbound_policy_revision = ?`,
                    )
                    .bind(nextRevision, now, deliveryTargetId, access.botId, expectedPolicyRevision),
                this.audit(
                    access.scope,
                    access.botId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "bot.delivery_target.approved",
                    deliveryTargetId,
                    { policyRevision: nextRevision.toString() },
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly writeTargetDisabling = async (
        access: BotConnectionAccess,
        deliveryTargetId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        `UPDATE bot_delivery_targets
                        SET lifecycle = 'disabled', lifecycle_revision = lifecycle_revision + 1,
                            updated_at = ?, disabled_at = ?
                      WHERE delivery_target_id = ? AND connection_id = ? AND lifecycle = 'active'`,
                    )
                    .bind(now, now, deliveryTargetId, access.connectionId),
                this.audit(
                    access.scope,
                    access.botId,
                    "connector",
                    access.connectorPrincipalId,
                    "bot.delivery_target.disabled",
                    deliveryTargetId,
                    {},
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly hasBindingTarget = async (
        botId: string,
        bindingId: string,
        deliveryTargetId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const allowed = await this.#database
            .prepare(
                `SELECT 1 AS allowed
                   FROM bot_execution_bindings AS bindings,
                        json_each(bindings.allowed_delivery_target_ids_json) AS target
                  WHERE bindings.binding_id = ? AND bindings.bot_id = ?
                    AND bindings.lifecycle = 'approved' AND target.value = ?`,
            )
            .bind(bindingId, botId, deliveryTargetId)
            .first<{ readonly allowed: number }>(signal);
        signal.throwIfAborted();
        return allowed !== null;
    };

    readonly listActiveTargetIds = async (connectionId: string, signal: AbortSignal): Promise<readonly string[]> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT delivery_target_id FROM bot_delivery_targets
                  WHERE connection_id = ? AND lifecycle = 'active' AND owner_approved = 1
                  ORDER BY created_at, delivery_target_id`,
            )
            .bind(validateIdentifier(connectionId, "connection_id"))
            .all<{ readonly delivery_target_id: string }>(signal);
        signal.throwIfAborted();
        return rows.results.map((row) => row.delivery_target_id);
    };

    readonly readTarget = async (deliveryTargetId: string, signal: AbortSignal): Promise<TargetRow | null> => {
        const target = await this.#database
            .prepare(
                `SELECT targets.delivery_target_id, targets.bot_id, targets.connection_id,
                        targets.alias, targets.outbound_policy_revision,
                        targets.lifecycle, targets.owner_approved,
                        connections.lifecycle AS connection_lifecycle
                   FROM bot_delivery_targets AS targets
                   INNER JOIN bot_connections AS connections
                     ON connections.connection_id = targets.connection_id
                  WHERE targets.delivery_target_id = ?`,
            )
            .bind(validateIdentifier(deliveryTargetId, "delivery_target_id"))
            .first<TargetRow>(signal);
        signal.throwIfAborted();
        return target;
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
