import { hashSecret, ProjectScope, validateIdentifier, validateToken } from "@moxt-ai/mobius-relay-core";

import { BotApiError } from "./bot-api-error.ts";

interface OwnerRow {
    readonly bot_id: string;
    readonly credential_id: string;
    readonly project_id: string;
    readonly tenant_id: string;
}

interface ProjectOwnerRow {
    readonly credential_id: string;
    readonly project_id: string;
    readonly tenant_id: string;
}

interface ConnectorRow {
    readonly audience: string;
    readonly bot_id: string;
    readonly connection_id: string;
    readonly connector_principal_id: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly scopes_json: string;
    readonly tenant_id: string;
}

interface RuntimeExecutionRow {
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly bot_lifecycle: string;
    readonly capability_id: string;
    readonly conversation_id: string;
    readonly execution_id: string;
    readonly local_grant_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly session_id: string;
    readonly tenant_id: string;
    readonly turn_id: string;
}

export class BotOwnerAccess {
    readonly botId: string;
    readonly credentialId: string;
    readonly scope: ProjectScope;

    constructor(scope: ProjectScope, credentialId: string, botId: string) {
        this.scope = scope;
        this.credentialId = credentialId;
        this.botId = botId;
    }
}

export class ProjectOwnerAccess {
    readonly credentialId: string;
    readonly scope: ProjectScope;

    constructor(scope: ProjectScope, credentialId: string) {
        this.scope = scope;
        this.credentialId = credentialId;
    }
}

export class BotConnectorAccess {
    readonly audience: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly connectorPrincipalId: string;
    readonly credentialId: string;
    readonly scope: ProjectScope;
    readonly scopes: readonly string[];

    constructor(
        scope: ProjectScope,
        botId: string,
        connectionId: string,
        credentialId: string,
        connectorPrincipalId: string,
        audience: string,
        scopes: readonly string[],
    ) {
        this.scope = scope;
        this.botId = botId;
        this.connectionId = connectionId;
        this.credentialId = credentialId;
        this.connectorPrincipalId = connectorPrincipalId;
        this.audience = audience;
        this.scopes = Object.freeze([...scopes]);
    }
}

export abstract class InboundBotPrincipal {
    readonly botId: string;
    abstract readonly kind: string;
    readonly principalId: string;
    readonly scope: ProjectScope;

    protected constructor(scope: ProjectScope, botId: string, principalId: string) {
        this.scope = scope;
        this.botId = botId;
        this.principalId = principalId;
    }
}

export class InboundBotOwnerPrincipal extends InboundBotPrincipal {
    readonly kind = "owner";

    constructor(access: BotOwnerAccess) {
        super(access.scope, access.botId, access.credentialId);
    }
}

export class InboundBotConnectorPrincipal extends InboundBotPrincipal {
    readonly connection: BotConnectorAccess;
    readonly kind = "connection";

    constructor(access: BotConnectorAccess) {
        super(access.scope, access.botId, access.connectorPrincipalId);
        this.connection = access;
    }
}

export class BotRuntimeExecutionAccess {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly localGrantId: string;
    readonly runtimeId: string;
    readonly scope: ProjectScope;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(row: RuntimeExecutionRow) {
        this.scope = new ProjectScope(row.tenant_id, row.project_id);
        this.executionId = row.execution_id;
        this.botId = row.bot_id;
        this.conversationId = row.conversation_id;
        this.turnId = row.turn_id;
        this.sessionId = row.session_id;
        this.behaviorRevisionId = row.behavior_revision_id;
        this.bindingId = row.binding_id;
        this.bindingRevision = row.binding_revision;
        this.runtimeId = row.runtime_id;
        this.capabilityId = row.capability_id;
        this.localGrantId = row.local_grant_id;
    }
}

function decodeScopes(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The connection authorization is invalid", 503, {
            cause,
        });
    }
    if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
        throw new BotApiError("bot_service_unavailable", "The connection authorization is invalid", 503);
    }
    return value.filter((scope) => typeof scope === "string");
}

export class D1BotAuthorization {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly authorizeProjectOwner = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ProjectOwnerAccess> => {
        signal.throwIfAborted();
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT channels.tenant_id, channels.project_id, credentials.credential_id
                   FROM pairing_channels AS channels
                   INNER JOIN channel_host_credentials AS credentials
                     ON credentials.channel_id = channels.channel_id
                  WHERE channels.project_id = ?
                    AND channels.status = 'paired'
                    AND credentials.authority = 'owner'
                    AND credentials.revoked_at IS NULL
                    AND credentials.token_hash = ?`,
            )
            .bind(normalizedProjectId, tokenDigest)
            .first<ProjectOwnerRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("owner_access_required", "An owner credential is required", 403);
        }
        return new ProjectOwnerAccess(new ProjectScope(row.tenant_id, row.project_id), row.credential_id);
    };

    readonly authorizeBotOwner = async (botId: string, token: string, signal: AbortSignal): Promise<BotOwnerAccess> => {
        signal.throwIfAborted();
        const normalizedBotId = validateIdentifier(botId, "bot_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT bots.bot_id, bots.tenant_id, bots.project_id, credentials.credential_id
                   FROM bots
                   INNER JOIN pairing_channels AS channels
                     ON channels.tenant_id = bots.tenant_id AND channels.project_id = bots.project_id
                   INNER JOIN channel_host_credentials AS credentials
                     ON credentials.channel_id = channels.channel_id
                  WHERE bots.bot_id = ?
                    AND channels.status = 'paired'
                    AND credentials.authority = 'owner'
                    AND credentials.revoked_at IS NULL
                    AND credentials.token_hash = ?`,
            )
            .bind(normalizedBotId, tokenDigest)
            .first<OwnerRow>();
        signal.throwIfAborted();
        if (row === null) {
            const exists = await this.#database
                .prepare(`SELECT 1 AS present FROM bots WHERE bot_id = ?`)
                .bind(normalizedBotId)
                .first<{ readonly present: number }>();
            signal.throwIfAborted();
            if (exists === null) {
                throw new BotApiError("bot_not_found", "The Bot does not exist", 404);
            }
            throw new BotApiError("owner_access_required", "An owner credential is required", 403);
        }
        return new BotOwnerAccess(new ProjectScope(row.tenant_id, row.project_id), row.credential_id, row.bot_id);
    };

    readonly authorizeConnector = async (
        connectionId: string,
        token: string,
        requiredScope: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => {
        const access = await this.authorizeConnectorCredential(connectionId, token, signal);
        if (!access.scopes.includes(requiredScope)) {
            throw new BotApiError("scope_denied", "The Bot connection scope is not granted", 403);
        }
        return access;
    };

    readonly authorizeConnectorManagement = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => await this.authorizeConnectorCredential(connectionId, token, signal);

    private readonly authorizeConnectorCredential = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => {
        signal.throwIfAborted();
        const normalizedConnectionId = validateIdentifier(connectionId, "connection_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const now = Date.now();
        const row = await this.#database
            .prepare(
                `SELECT connections.connection_id, connections.bot_id,
                        connections.connector_principal_id, connections.audience,
                        connections.scopes_json, credentials.credential_id,
                        credentials.expires_at, bots.tenant_id, bots.project_id
                   FROM bot_connections AS connections
                   INNER JOIN bot_connection_credentials AS credentials
                     ON credentials.connection_id = connections.connection_id
                   INNER JOIN bots ON bots.bot_id = connections.bot_id
                  WHERE connections.connection_id = ?
                    AND connections.lifecycle = 'active'
                    AND credentials.secret_digest = ?
                    AND credentials.revoked_at IS NULL
                    AND credentials.expires_at > ?`,
            )
            .bind(normalizedConnectionId, tokenDigest, now)
            .first<ConnectorRow>();
        signal.throwIfAborted();
        if (row === null) {
            const connection = await this.#database
                .prepare(`SELECT lifecycle FROM bot_connections WHERE connection_id = ?`)
                .bind(normalizedConnectionId)
                .first<{ readonly lifecycle: string }>();
            signal.throwIfAborted();
            if (connection?.lifecycle === "revoked") {
                throw new BotApiError("connection_revoked", "The Bot connection was revoked", 401);
            }
            throw new BotApiError("credential_invalid", "The Bot connection credential is invalid", 401);
        }
        const scopes = decodeScopes(row.scopes_json);
        const touched = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_connection_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
                )
                .bind(now, row.credential_id, now),
            this.#database
                .prepare(
                    `UPDATE bot_connections SET last_used_at = ?
                      WHERE connection_id = ? AND lifecycle = 'active'`,
                )
                .bind(now, row.connection_id),
        ]);
        signal.throwIfAborted();
        if (touched.some((result) => result.meta.changes !== 1)) {
            throw new BotApiError("credential_invalid", "The Bot connection credential is invalid", 401);
        }
        return new BotConnectorAccess(
            new ProjectScope(row.tenant_id, row.project_id),
            row.bot_id,
            row.connection_id,
            row.credential_id,
            row.connector_principal_id,
            row.audience,
            scopes,
        );
    };

    readonly authorizeInbound = async (
        botId: string,
        token: string,
        requiredConnectorScope: string,
        signal: AbortSignal,
    ): Promise<InboundBotPrincipal> => {
        try {
            return new InboundBotOwnerPrincipal(await this.authorizeBotOwner(botId, token, signal));
        } catch (error) {
            if (!(error instanceof BotApiError) || error.code === "bot_not_found") {
                throw error;
            }
        }
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT connections.connection_id
                   FROM bot_connections AS connections
                   INNER JOIN bot_connection_credentials AS credentials
                     ON credentials.connection_id = connections.connection_id
                  WHERE connections.bot_id = ? AND credentials.secret_digest = ?
                  ORDER BY credentials.issued_at DESC LIMIT 1`,
            )
            .bind(validateIdentifier(botId, "bot_id"), tokenDigest)
            .first<{ readonly connection_id: string }>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation is not accessible", 403);
        }
        return new InboundBotConnectorPrincipal(
            await this.authorizeConnector(row.connection_id, token, requiredConnectorScope, signal),
        );
    };

    readonly authorizeRuntimeExecution = async (
        executionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotRuntimeExecutionAccess> => {
        signal.throwIfAborted();
        const tokenDigest = await hashSecret(validateToken(token));
        const row = await this.#database
            .prepare(
                `SELECT executions.execution_id, executions.bot_id,
                        executions.conversation_id, executions.turn_id,
                        executions.session_id, executions.behavior_revision_id,
                        executions.binding_id, executions.binding_revision,
                        executions.runtime_id, executions.capability_id,
                        bots.tenant_id, bots.project_id,
                        bots.lifecycle AS bot_lifecycle,
                        bindings.local_grant_id
                   FROM bot_execution_directory AS executions
                   INNER JOIN bots ON bots.bot_id = executions.bot_id
                   INNER JOIN bot_execution_bindings AS bindings
                     ON bindings.binding_id = executions.binding_id
                    AND bindings.bot_id = executions.bot_id
                    AND bindings.binding_revision = executions.binding_revision
                   INNER JOIN pairing_channels AS channels
                     ON channels.tenant_id = bots.tenant_id
                    AND channels.project_id = bots.project_id
                    AND channels.runtime_id = executions.runtime_id
                  WHERE executions.execution_id = ?
                    AND channels.daemon_token_hash = ?
                    AND channels.status = 'paired'
                    AND bindings.lifecycle = 'approved'`,
            )
            .bind(validateIdentifier(executionId, "execution_id"), tokenDigest)
            .first<RuntimeExecutionRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError(
                "execution_context_required",
                "An authenticated Bot execution context is required",
                401,
            );
        }
        if (row.bot_lifecycle === "suspended") {
            throw new BotApiError("bot_suspended", "The Bot is suspended", 409);
        }
        if (row.bot_lifecycle !== "active") {
            throw new BotApiError("bot_not_active", "The Bot is not active", 409);
        }
        return new BotRuntimeExecutionAccess(row);
    };
}
