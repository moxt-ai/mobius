import type { BotGrantCredential } from "../entity/bot/bot-grant.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    type BotConversationScopeRecord,
    type BotCredentialRecords,
    type BotProjectScopeRecord,
    FoundBotConversationScope,
    FoundBotProjectScope,
    type InboundCredentialPlaneRecord,
    MissingBotConversationScope,
    MissingBotProjectScope,
} from "./bot-credential-records.ts";

export class BotCredentialStorage implements BotCredentialRecords {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readGrant = async (
        grantId: string,
        digest: string,
        audience: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const row = await this.#database
            .prepare(`SELECT grants.bot_id, grants.audience, grants.label,
            grants.scopes_json, grants.expires_at, bots.tenant_id, bots.project_id
            FROM bot_connection_grants AS grants INNER JOIN bots ON bots.bot_id = grants.bot_id
            WHERE grants.grant_id = ? AND grants.secret_digest = ? AND grants.audience = ?
            AND grants.consumed_at IS NULL AND grants.expires_at > ?`)
            .bind(grantId, digest, audience, now)
            .first<BotGrantCredential>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly botExists: BotCredentialRecords["botExists"] = async (botId, signal) =>
        (await this.#database.prepare("SELECT 1 AS present FROM bots WHERE bot_id = ?").bind(botId).first(signal)) !==
        null;

    readonly botExistsInProject: BotCredentialRecords["botExistsInProject"] = async (
        botId,
        tenantId,
        projectId,
        signal,
    ) =>
        (await this.#database
            .prepare("SELECT 1 AS present FROM bots WHERE bot_id = ? AND tenant_id = ? AND project_id = ?")
            .bind(botId, tenantId, projectId)
            .first(signal)) !== null;

    readonly readBotProjectScope: BotCredentialRecords["readBotProjectScope"] = async (botId, signal) => {
        const row = await this.#database
            .prepare("SELECT tenant_id, project_id FROM bots WHERE bot_id = ?")
            .bind(botId)
            .first<BotProjectScopeRecord>(signal);
        return row === null ? new MissingBotProjectScope() : new FoundBotProjectScope(row.tenant_id, row.project_id);
    };

    readonly readConversationProjectScope: BotCredentialRecords["readConversationProjectScope"] = async (
        conversationId,
        signal,
    ) => {
        const row = await this.#database
            .prepare(
                `SELECT conversations.bot_id, conversations.session_id, bots.tenant_id, bots.project_id
                   FROM bot_conversations AS conversations
                   INNER JOIN bots ON bots.bot_id = conversations.bot_id
                  WHERE conversations.conversation_id = ?`,
            )
            .bind(conversationId)
            .first<BotConversationScopeRecord>(signal);
        return row === null
            ? new MissingBotConversationScope()
            : new FoundBotConversationScope(row.tenant_id, row.project_id, row.bot_id, row.session_id);
    };

    readonly readConnector: BotCredentialRecords["readConnector"] = (connectionId, digest, now, signal) =>
        this.#database
            .prepare(
                `SELECT connections.connection_id, connections.bot_id, connections.connector_principal_id,
                    connections.audience, connections.scopes_json, credentials.credential_id,
                    credentials.expires_at, bots.tenant_id, bots.project_id
             FROM bot_connections AS connections
             JOIN bot_connection_credentials AS credentials ON credentials.connection_id = connections.connection_id
             JOIN bots ON bots.bot_id = connections.bot_id
             WHERE connections.connection_id = ? AND connections.lifecycle = 'active'
               AND credentials.secret_digest = ? AND credentials.revoked_at IS NULL
               AND credentials.expires_at > ?`,
            )
            .bind(connectionId, digest, now)
            .first(signal);

    readonly readConnectionLifecycle: BotCredentialRecords["readConnectionLifecycle"] = async (
        connectionId,
        signal,
    ) => {
        const row = await this.#database
            .prepare("SELECT lifecycle FROM bot_connections WHERE connection_id = ?")
            .bind(connectionId)
            .first<{ readonly lifecycle: string }>(signal);
        return row?.lifecycle ?? null;
    };

    readonly recordConnectionUse: BotCredentialRecords["recordConnectionUse"] = async (
        credentialId,
        connectionId,
        now,
        signal,
    ) => {
        const results = await this.#database.batch(
            [
                this.#database
                    .prepare(
                        "UPDATE bot_connection_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?",
                    )
                    .bind(now, credentialId, now),
                this.#database
                    .prepare(
                        "UPDATE bot_connections SET last_used_at = ? WHERE connection_id = ? AND lifecycle = 'active'",
                    )
                    .bind(now, connectionId),
            ],
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readInboundCredentialPlanes: BotCredentialRecords["readInboundCredentialPlanes"] = async (
        botId,
        digest,
        now,
        signal,
    ) => {
        const rows = await this.#database
            .prepare(
                `SELECT 'project' AS plane, NULL AS connection_id
                   FROM bots
                   INNER JOIN project_owner_credentials AS credentials
                     ON credentials.tenant_id = bots.tenant_id AND credentials.project_id = bots.project_id
                  WHERE bots.bot_id = ? AND credentials.token_hash = ? AND credentials.revoked_at IS NULL
                    AND (credentials.replaced_by_credential_id IS NULL OR credentials.overlap_ends_at > ?)
                 UNION ALL
                 SELECT 'project' AS plane, NULL AS connection_id
                   FROM bots
                   INNER JOIN project_browser_credentials AS credentials
                     ON credentials.tenant_id = bots.tenant_id AND credentials.project_id = bots.project_id
                  WHERE bots.bot_id = ? AND credentials.token_hash = ? AND credentials.revoked_at IS NULL
                    AND credentials.expires_at > ?
                 UNION ALL
                 SELECT 'project' AS plane, NULL AS connection_id
                   FROM bots
                   INNER JOIN pairing_channels AS channels
                     ON channels.tenant_id = bots.tenant_id AND channels.project_id = bots.project_id
                   INNER JOIN channel_host_credentials AS credentials ON credentials.channel_id = channels.channel_id
                  WHERE bots.bot_id = ? AND credentials.token_hash = ? AND credentials.authority = 'linked'
                    AND credentials.revoked_at IS NULL AND channels.status = 'paired'
                    AND (credentials.replaced_by_credential_id IS NULL OR credentials.overlap_ends_at > ?)
                 UNION ALL
                 SELECT 'connector' AS plane, connections.connection_id
                   FROM bot_connections AS connections
                   INNER JOIN bot_connection_credentials AS credentials
                     ON credentials.connection_id = connections.connection_id
                  WHERE connections.bot_id = ? AND credentials.secret_digest = ?`,
            )
            .bind(botId, digest, now, botId, digest, now, botId, digest, now, botId, digest)
            .all<InboundCredentialPlaneRecord>(signal);
        return rows.results;
    };

    readonly readRuntimeExecution: BotCredentialRecords["readRuntimeExecution"] = (executionId, digest, signal) =>
        this.#database
            .prepare(
                `SELECT executions.execution_id, executions.bot_id, executions.conversation_id, executions.turn_id,
                    executions.session_id, executions.behavior_revision_id, executions.binding_id,
                    executions.binding_revision, executions.runtime_id, executions.capability_id,
                    bots.tenant_id, bots.project_id, bots.lifecycle AS bot_lifecycle,
                    channels.channel_id, channels.pairing_id, bindings.local_grant_id
             FROM bot_execution_directory AS executions
             JOIN bots ON bots.bot_id = executions.bot_id
             JOIN bot_execution_bindings AS bindings
               ON bindings.binding_id = executions.binding_id AND bindings.bot_id = executions.bot_id
              AND bindings.binding_revision = executions.binding_revision
             JOIN pairing_channels AS channels
               ON channels.tenant_id = bots.tenant_id AND channels.project_id = bots.project_id
              AND channels.runtime_id = executions.runtime_id
             WHERE executions.execution_id = ? AND channels.daemon_token_hash = ?
               AND channels.status = 'paired' AND bindings.lifecycle = 'approved'`,
            )
            .bind(executionId, digest)
            .first(signal);
}
