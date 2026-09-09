import { createRandomToken, hashSecret, ProjectScope, validateIdentifier } from "@moxt-ai/mobius-relay-core";

import { BotApiError } from "./bot-api-error.ts";
import type { BotConnectorAccess, BotOwnerAccess } from "./d1-bot-auth.ts";

const BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const BOT_CONNECTION_CREDENTIAL_OVERLAP_MILLISECONDS = 5 * 60 * 1_000;
const MAX_CONNECTION_GRANT_LIFETIME_SECONDS = 3_600;
const MIN_CONNECTION_GRANT_LIFETIME_SECONDS = 60;

interface GrantRow {
    readonly audience: string;
    readonly bot_id: string;
    readonly expires_at: number;
    readonly label: string;
    readonly project_id: string;
    readonly scopes_json: string;
    readonly tenant_id: string;
}

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

export class BotDeliveryRoute {
    readonly alias: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly deliveryTargetId: string;
    readonly policyRevision: number;

    constructor(row: TargetRow) {
        this.deliveryTargetId = row.delivery_target_id;
        this.botId = row.bot_id;
        this.connectionId = row.connection_id;
        this.alias = row.alias;
        this.policyRevision = row.outbound_policy_revision;
    }
}

function decodeScopes(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The Bot connection grant is invalid", 503, { cause });
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new BotApiError("bot_service_unavailable", "The Bot connection grant is invalid", 503);
    }
    return value.filter((entry) => typeof entry === "string");
}

export class D1BotConnections {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly createGrant = async (
        access: BotOwnerAccess,
        audience: string,
        label: string,
        scopes: readonly string[],
        expiresInSeconds: number,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (
            !Number.isSafeInteger(expiresInSeconds) ||
            expiresInSeconds < MIN_CONNECTION_GRANT_LIFETIME_SECONDS ||
            expiresInSeconds > MAX_CONNECTION_GRANT_LIFETIME_SECONDS
        ) {
            throw new BotApiError("invalid_request", "The connection grant lifetime is invalid", 400);
        }
        const bot = await this.#database
            .prepare(`SELECT lifecycle FROM bots WHERE bot_id = ?`)
            .bind(access.botId)
            .first<{ readonly lifecycle: string }>();
        if (bot === null || bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "The Bot cannot create a connection grant", 409);
        }
        const grantId = `bcg_${createRandomToken(18)}`;
        const grantSecret = createRandomToken(32);
        const expiresAt = now + expiresInSeconds * 1_000;
        const results = await this.#database.batch([
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
                .bind(
                    grantId,
                    audience,
                    label,
                    JSON.stringify(scopes),
                    await hashSecret(grantSecret),
                    now,
                    expiresAt,
                    access.botId,
                ),
            this.audit(
                access.scope,
                access.botId,
                "owner",
                access.credentialId,
                "bot.connection_grant.created",
                grantId,
                { audience, label },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("bot_service_unavailable", "The Bot connection grant was not created", 503);
        }
        return {
            audience,
            botId: access.botId,
            expiresAt: new Date(expiresAt).toISOString(),
            grantId,
            grantSecret,
            label,
            scopes,
        };
    };

    readonly redeemGrant = async (
        grantId: string,
        grantSecret: string,
        audience: string,
        connectorPrincipalId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedGrantId = validateIdentifier(grantId, "grant_id");
        const grantDigest = await hashSecret(grantSecret);
        const grant = await this.#database
            .prepare(
                `SELECT grants.bot_id, grants.audience, grants.label,
                        grants.scopes_json, grants.expires_at,
                        bots.tenant_id, bots.project_id
                   FROM bot_connection_grants AS grants
                   INNER JOIN bots ON bots.bot_id = grants.bot_id
                  WHERE grants.grant_id = ? AND grants.secret_digest = ? AND grants.audience = ?
                    AND grants.consumed_at IS NULL AND grants.expires_at > ?`,
            )
            .bind(normalizedGrantId, grantDigest, audience, now)
            .first<GrantRow>();
        signal.throwIfAborted();
        if (grant === null) {
            throw new BotApiError("credential_invalid", "The Bot connection grant is invalid or consumed", 401);
        }
        const connectionId = `bcn_${createRandomToken(18)}`;
        const credentialId = `bcc_${createRandomToken(18)}`;
        const credential = createRandomToken(32);
        const credentialDigest = await hashSecret(credential);
        const expiresAt = now + BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS;
        const results = await this.#database.batch([
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
                new ProjectScope(grant.tenant_id, grant.project_id),
                grant.bot_id,
                "connector",
                connectorPrincipalId,
                "bot.connection.created",
                connectionId,
                { grantId: normalizedGrantId },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("credential_invalid", "The Bot connection grant is invalid or consumed", 401);
        }
        return {
            audience: grant.audience,
            botId: grant.bot_id,
            connectionId,
            connectorPrincipalId,
            credential,
            credentialExpiresAt: new Date(expiresAt).toISOString(),
            credentialId,
            label: grant.label,
            lifecycle: "active",
            lifecycleRevision: 1,
            scopes: decodeScopes(grant.scopes_json),
        };
    };

    readonly rotateCredential = async (
        access: BotConnectorAccess,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const credentialId = `bcc_${createRandomToken(18)}`;
        const credential = createRandomToken(32);
        const expiresAt = now + BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS;
        const oldExpiresAt = now + BOT_CONNECTION_CREDENTIAL_OVERLAP_MILLISECONDS;
        const results = await this.#database.batch([
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
                    await hashSecret(credential),
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
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("credential_invalid", "The Bot connection credential could not rotate", 401);
        }
        return {
            connectionId: access.connectionId,
            credential,
            credentialExpiresAt: new Date(expiresAt).toISOString(),
            credentialId,
            overlapEndsAt: new Date(oldExpiresAt).toISOString(),
        };
    };

    readonly revokeConnection = async (
        access: BotConnectorAccess,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const results = await this.#database.batch([
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
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
            throw new BotApiError("connection_revoked", "The Bot connection was already revoked", 401);
        }
        return {
            botId: access.botId,
            connectionId: access.connectionId,
            lifecycle: "revoked",
            lifecycleRevision: 2,
            revokedAt: new Date(now).toISOString(),
        };
    };

    readonly createTarget = async (
        access: BotConnectorAccess,
        alias: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const deliveryTargetId = `bdt_${createRandomToken(18)}`;
        try {
            const results = await this.#database.batch([
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
            ]);
            signal.throwIfAborted();
            if (results.some((result) => result.meta.changes !== 1)) {
                throw new Error("Target insert was not applied");
            }
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotApiError("revision_conflict", "The delivery target alias is already registered", 409, {
                cause,
            });
        }
        return {
            alias,
            botId: access.botId,
            connectionId: access.connectionId,
            createdAt: new Date(now).toISOString(),
            deliveryTargetId,
            lifecycle: "active",
            lifecycleRevision: 1,
            outboundPolicyRevision: 0,
            ownerApproved: false,
        };
    };

    readonly approveTarget = async (
        access: BotOwnerAccess,
        deliveryTargetId: string,
        expectedPolicyRevision: number,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const nextRevision = expectedPolicyRevision + 1;
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_delivery_targets
                        SET owner_approved = 1, outbound_policy_revision = ?, updated_at = ?
                      WHERE delivery_target_id = ? AND bot_id = ? AND lifecycle = 'active'
                        AND outbound_policy_revision = ?`,
                )
                .bind(
                    nextRevision,
                    now,
                    validateIdentifier(deliveryTargetId, "delivery_target_id"),
                    access.botId,
                    expectedPolicyRevision,
                ),
            this.audit(
                access.scope,
                access.botId,
                "owner",
                access.credentialId,
                "bot.delivery_target.approved",
                deliveryTargetId,
                { policyRevision: nextRevision.toString() },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("revision_conflict", "The delivery target policy revision changed", 409);
        }
        const target = await this.readTarget(deliveryTargetId, signal);
        return {
            alias: target.alias,
            botId: target.bot_id,
            connectionId: target.connection_id,
            deliveryTargetId: target.delivery_target_id,
            lifecycle: target.lifecycle,
            lifecycleRevision: 1,
            outboundPolicyRevision: target.outbound_policy_revision,
            ownerApproved: true,
        };
    };

    readonly disableTarget = async (
        access: BotConnectorAccess,
        deliveryTargetId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_delivery_targets
                        SET lifecycle = 'disabled', lifecycle_revision = lifecycle_revision + 1,
                            updated_at = ?, disabled_at = ?
                      WHERE delivery_target_id = ? AND connection_id = ? AND lifecycle = 'active'`,
                )
                .bind(now, now, validateIdentifier(deliveryTargetId, "delivery_target_id"), access.connectionId),
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
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target is unavailable", 409);
        }
        return {
            connectionId: access.connectionId,
            deliveryTargetId,
            disabledAt: new Date(now).toISOString(),
            lifecycle: "disabled",
        };
    };

    readonly authorizeOutboundTarget = async (
        botId: string,
        bindingId: string,
        deliveryTargetId: string,
        signal: AbortSignal,
    ): Promise<BotDeliveryRoute> => {
        signal.throwIfAborted();
        const target = await this.readTarget(deliveryTargetId, signal);
        if (target.bot_id !== botId) {
            throw new BotApiError("delivery_target_not_allowed", "The delivery target belongs to another Bot", 403);
        }
        const allowed = await this.#database
            .prepare(
                `SELECT 1 AS allowed
                   FROM bot_execution_bindings AS bindings,
                        json_each(bindings.allowed_delivery_target_ids_json) AS target
                  WHERE bindings.binding_id = ? AND bindings.bot_id = ?
                    AND bindings.lifecycle = 'approved' AND target.value = ?`,
            )
            .bind(bindingId, botId, target.delivery_target_id)
            .first<{ readonly allowed: number }>();
        signal.throwIfAborted();
        if (allowed === null) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The delivery target is outside the approved binding",
                403,
            );
        }
        if (target.lifecycle !== "active" || target.connection_lifecycle !== "active" || target.owner_approved !== 1) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target is unavailable", 409);
        }
        return new BotDeliveryRoute(target);
    };

    readonly authorizeConversationReplyTarget = async (
        botId: string,
        connectionId: string,
        deliveryTargetId: string,
        signal: AbortSignal,
    ): Promise<BotDeliveryRoute> => {
        const target = await this.readTarget(deliveryTargetId, signal);
        if (target.bot_id !== botId || target.connection_id !== connectionId) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The reply target does not belong to this Bot connection",
                403,
            );
        }
        if (target.lifecycle !== "active" || target.connection_lifecycle !== "active" || target.owner_approved !== 1) {
            throw new BotApiError("delivery_target_unavailable", "The reply target is unavailable", 409);
        }
        return new BotDeliveryRoute(target);
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
            .all<{ readonly delivery_target_id: string }>();
        signal.throwIfAborted();
        return rows.results.map((row) => row.delivery_target_id);
    };

    private readonly readTarget = async (deliveryTargetId: string, signal: AbortSignal): Promise<TargetRow> => {
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
            .first<TargetRow>();
        signal.throwIfAborted();
        if (target === null) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target does not exist", 404);
        }
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
