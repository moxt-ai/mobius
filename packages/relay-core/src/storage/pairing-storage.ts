import type {
    PairingChannelRow,
    RevocableRuntimeRow,
    RuntimeDirectoryRow,
    RuntimePairingAudit,
    RuntimePairingRow,
} from "../entity/pairing/pairing-records.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";

interface ChannelScopeRow {
    readonly channel_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
}
interface DaemonChannelScopeRow extends ChannelScopeRow {
    readonly pairing_id: string;
}
export interface AuthorizedChannelRow extends ChannelScopeRow {
    readonly credential_id: string;
    readonly authority: string;
}
interface PublicChannelRow extends ChannelScopeRow {
    readonly agents_json: string;
    readonly machine_name: string;
    readonly workspace_name: string;
}
interface BrowserCredentialRow {
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly revoked_at: unknown;
}

export class PairingStorage {
    readonly #database: SqlDatabase;
    constructor(project: ProjectStorageContext, databases: DatabaseResolver) {
        this.#database = databases.resolve(project.storagePlacement);
    }

    readonly readHost = (channelId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM pairing_channels AS channels INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.channel_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.status = 'paired'
            AND (credentials.replaced_by_credential_id IS NULL OR credentials.overlap_ends_at > ?)`)
            .bind(channelId, tokenHash, Date.now())
            .first<AuthorizedChannelRow>(signal);

    readonly readProjectHost = (projectId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM pairing_channels AS channels INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.project_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.status = 'paired'`)
            .bind(projectId, tokenHash)
            .first<AuthorizedChannelRow>(signal);

    readonly readRuntimeHost = (projectId: string, runtimeId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM pairing_channels AS channels INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.project_id = ? AND channels.runtime_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.status = 'paired'`)
            .bind(projectId, runtimeId, tokenHash)
            .first<AuthorizedChannelRow>(signal);

    readonly touchHost = (credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE channel_host_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL
            AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`)
            .bind(now, credentialId, now)
            .run(signal);

    readonly readBrowser = (projectId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id, project_id, expires_at, revoked_at FROM project_browser_credentials
        WHERE project_id = ? AND token_hash = ?`)
            .bind(projectId, tokenHash)
            .first<BrowserCredentialRow>(signal);

    readonly touchBrowser = (credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE project_browser_credentials SET last_used_at = ?
        WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`)
            .bind(now, credentialId, now)
            .run(signal);

    readonly readDaemon = (channelId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channel_id, pairing_id, runtime_id, project_id FROM pairing_channels
        WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`)
            .bind(channelId, tokenHash)
            .first<DaemonChannelScopeRow>(signal);

    readonly readRuntime = (projectId: string, runtimeId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channel_id, runtime_id, project_id, status, agents_json FROM pairing_channels
        WHERE project_id = ? AND runtime_id = ?`)
            .bind(projectId, runtimeId)
            .first<RuntimeDirectoryRow>(signal);

    readonly claim = (
        codeHash: string,
        daemonHash: string,
        now: number,
        machineName: string,
        workspaceName: string,
        agents: string,
        auditId: string,
        signal: AbortSignal,
    ) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`
        UPDATE pairing_channels SET status = 'paired', daemon_token_hash = ?, claimed_at = ?, machine_name = ?,
            workspace_name = ?, agents_json = ?
        WHERE pairing_code_hash = ? AND status = 'pending' AND expires_at > ?`)
                    .bind(daemonHash, now, machineName, workspaceName, agents, codeHash, now),
                this.#database
                    .prepare(`INSERT OR IGNORE INTO runtime_pairing_audit_events
                (audit_id, project_id, pairing_id, runtime_id, actor_kind, actor_id, action, details_json, recorded_at)
                SELECT ?, project_id, pairing_id, runtime_id, 'runtime', runtime_id,
                    'runtime_pairing.claimed', '{}', ? FROM pairing_channels
                WHERE pairing_code_hash = ? AND status = 'paired' AND daemon_token_hash = ? AND claimed_at = ?`)
                    .bind(auditId, now, codeHash, daemonHash, now),
            ],
            signal,
        );

    private readonly auditStatement = (value: RuntimePairingAudit) =>
        this.#database
            .prepare(`INSERT OR IGNORE INTO runtime_pairing_audit_events
            (audit_id, project_id, pairing_id, runtime_id, actor_kind, actor_id, action, details_json, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
                value.auditId,
                value.projectId,
                value.pairingId,
                value.runtimeId,
                value.actorKind,
                value.actorId,
                value.action,
                JSON.stringify(value.details),
                value.recordedAt,
            );

    readonly recordAudit = (value: RuntimePairingAudit, signal: AbortSignal) => this.auditStatement(value).run(signal);

    readonly expireProjectPairings = (projectId: string, now: number, auditPrefix: string, signal: AbortSignal) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`INSERT OR IGNORE INTO runtime_pairing_audit_events
                (audit_id, project_id, pairing_id, runtime_id, actor_kind, actor_id, action, details_json, recorded_at)
                SELECT ? || pairing_id, project_id, pairing_id, runtime_id,
                    'system', 'relay', 'runtime_pairing.expired', '{}', ? FROM pairing_channels
                WHERE project_id = ? AND status = 'pending' AND expires_at <= ?`)
                    .bind(auditPrefix, now, projectId, now),
                this.#database
                    .prepare(`UPDATE pairing_channels SET status = 'expired'
                WHERE project_id = ? AND status = 'pending' AND expires_at <= ?`)
                    .bind(projectId, now),
            ],
            signal,
        );

    readonly expirePairing = (pairingId: string, now: number, auditId: string, signal: AbortSignal) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`UPDATE pairing_channels SET status = 'expired'
                WHERE pairing_id = ? AND status = 'pending' AND expires_at <= ?`)
                    .bind(pairingId, now),
                this.#database
                    .prepare(`INSERT OR IGNORE INTO runtime_pairing_audit_events
                (audit_id, project_id, pairing_id, runtime_id, actor_kind, actor_id, action, details_json, recorded_at)
                SELECT ?, project_id, pairing_id, runtime_id, 'system', 'relay',
                    'runtime_pairing.expired', '{}', ? FROM pairing_channels WHERE pairing_id = ? AND status = 'expired'`)
                    .bind(auditId, now, pairingId),
            ],
            signal,
        );

    readonly readPairingCode = (codeHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT pairing_id, status, revoked_at, channel_id, runtime_id, expires_at,
            machine_name, workspace_name, agents_json, project_id
            FROM pairing_channels WHERE pairing_code_hash = ?`)
            .bind(codeHash)
            .first<PairingChannelRow>(signal);

    readonly readProjectPairing = (projectId: string, pairingId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT pairing_id, status, revoked_at, channel_id, runtime_id, expires_at,
            machine_name, workspace_name, agents_json, project_id
            FROM pairing_channels WHERE project_id = ? AND pairing_id = ?`)
            .bind(projectId, pairingId)
            .first<PairingChannelRow>(signal);

    readonly readRuntimePairingRequest = (projectId: string, idempotencyKey: string, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT pairing_id, pairing_code_hash, poll_token_hash, channel_id, runtime_id,
            project_id, expires_at, created_by_owner_credential_id FROM pairing_channels
            WHERE project_id = ? AND creation_idempotency_key = ?`)
            .bind(projectId, idempotencyKey)
            .first<RuntimePairingRow>(signal);

    readonly countActiveRuntimes = (projectId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT COUNT(*) AS active_count FROM pairing_channels
            WHERE project_id = ? AND status IN ('pending', 'paired')`)
            .bind(projectId)
            .first<{ readonly active_count: number }>(signal);

    readonly createRuntimePairing = (
        value: {
            readonly pairingId: string;
            readonly codeHash: string;
            readonly pollHash: string;
            readonly channelId: string;
            readonly runtimeId: string;
            readonly projectId: string;
            readonly now: number;
            readonly expiresAt: number;
            readonly idempotencyKey: string;
            readonly ownerId: string;
            readonly actorKind: string;
            readonly maximumRuntimes: number;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`WITH RECURSIVE runtime_slots(runtime_slot) AS (
            SELECT 1 UNION ALL SELECT runtime_slot + 1 FROM runtime_slots WHERE runtime_slot < ?
        ) INSERT INTO pairing_channels (pairing_id, pairing_code_hash, poll_token_hash, channel_id,
            runtime_id, project_id, status, created_at, expires_at, creation_idempotency_key,
            created_by_owner_credential_id, runtime_slot)
        SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, runtime_slot FROM runtime_slots
        WHERE NOT EXISTS (SELECT 1 FROM pairing_channels AS active WHERE active.project_id = ?
            AND active.runtime_slot = runtime_slots.runtime_slot
            AND active.status IN ('pending', 'paired')) ORDER BY runtime_slot LIMIT 1`)
                    .bind(
                        value.maximumRuntimes,
                        value.pairingId,
                        value.codeHash,
                        value.pollHash,
                        value.channelId,
                        value.runtimeId,
                        value.projectId,
                        value.now,
                        value.expiresAt,
                        value.idempotencyKey,
                        value.ownerId,
                        value.projectId,
                    ),
                this.#database
                    .prepare(`INSERT OR IGNORE INTO runtime_pairing_audit_events
            (audit_id, project_id, pairing_id, runtime_id, actor_kind, actor_id, action, details_json, recorded_at)
            SELECT ?, project_id, pairing_id, runtime_id, ?, ?, 'runtime_pairing.requested', ?, ?
            FROM pairing_channels WHERE pairing_id = ?`)
                    .bind(
                        value.auditId,
                        value.actorKind,
                        value.ownerId,
                        JSON.stringify({ idempotencyKey: value.idempotencyKey }),
                        value.now,
                        value.pairingId,
                    ),
            ],
            signal,
        );

    readonly readRevocableRuntime = (projectId: string, runtimeId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT pairing_id, channel_id, runtime_id, project_id, status, revoked_at
            FROM pairing_channels WHERE project_id = ? AND runtime_id = ?`)
            .bind(projectId, runtimeId)
            .first<RevocableRuntimeRow>(signal);

    readonly revokeRuntime = (
        value: {
            readonly pairingId: string;
            readonly channelId: string;
            readonly runtimeId: string;
            readonly projectId: string;
            readonly ownerId: string;
            readonly revokedAt: number;
            readonly audit: RuntimePairingAudit;
        },
        signal: AbortSignal,
    ) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`UPDATE pairing_channels SET status = 'revoked', daemon_token_hash = NULL,
            revoked_at = COALESCE(revoked_at, ?), revoked_by_owner_credential_id = COALESCE(revoked_by_owner_credential_id, ?)
            WHERE pairing_id = ? AND project_id = ? AND runtime_id = ?`)
                    .bind(value.revokedAt, value.ownerId, value.pairingId, value.projectId, value.runtimeId),
                this.#database
                    .prepare(`UPDATE channel_host_credentials SET revoked_at = COALESCE(revoked_at, ?)
            WHERE channel_id = ?`)
                    .bind(value.revokedAt, value.channelId),
                this.#database
                    .prepare(`UPDATE channel_access_grants SET expires_at = MIN(expires_at, ?)
            WHERE channel_id = ?`)
                    .bind(value.revokedAt, value.channelId),
                this.auditStatement(value.audit),
            ],
            signal,
        );

    readonly createGrant = (
        grantId: string,
        channelId: string,
        secretHash: string,
        credentialId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`
        INSERT INTO channel_access_grants (grant_id, channel_id, secret_hash, created_by_credential_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(grantId, channelId, secretHash, credentialId, now, expiresAt)
            .run(signal);

    readonly createBrowser = (
        credentialId: string,
        projectId: string,
        tokenHash: string,
        ownerId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`
        INSERT INTO project_browser_credentials (credential_id, project_id, token_hash,
            created_by_credential_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(credentialId, projectId, tokenHash, ownerId, now, expiresAt, now)
            .run(signal);

    readonly listLinked = (channelId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id, created_at, last_used_at FROM channel_host_credentials
        WHERE channel_id = ? AND authority = 'linked' AND revoked_at IS NULL ORDER BY created_at DESC, credential_id DESC`)
            .bind(channelId)
            .all<{ readonly credential_id: string; readonly created_at: number; readonly last_used_at: number }>(
                signal,
            );

    readonly listRuntimes = (projectId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channel_id, runtime_id, machine_name, workspace_name, agents_json, project_id
        FROM pairing_channels WHERE project_id = ? AND status = 'paired' ORDER BY created_at, channel_id LIMIT 100`)
            .bind(projectId)
            .all<PublicChannelRow>(signal);

    readonly readChannel = (channelId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channel_id, runtime_id, machine_name, workspace_name, agents_json, project_id
        FROM pairing_channels WHERE channel_id = ? AND status = 'paired'`)
            .bind(channelId)
            .first<PublicChannelRow>(signal);

    readonly createProjectControlHost = (
        projectId: string,
        runtimeId: string,
        credentialId: string,
        tokenHash: string,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`INSERT INTO channel_host_credentials
                (credential_id, channel_id, token_hash, authority, created_at, last_used_at)
                SELECT ?, channel_id, ?, 'linked', ?, ? FROM pairing_channels
                 WHERE project_id = ? AND runtime_id = ? AND status = 'paired'
                RETURNING channel_id, (SELECT agents_json FROM pairing_channels WHERE channel_id = channel_host_credentials.channel_id) AS agents_json`)
            .bind(credentialId, tokenHash, now, now, projectId, runtimeId)
            .first<{ readonly channel_id: string; readonly agents_json: string }>(signal);

    readonly removeControlHost = (channelId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(
                `DELETE FROM channel_host_credentials WHERE channel_id = ? AND credential_id = ? AND source_grant_id IS NULL AND authority = 'linked'`,
            )
            .bind(channelId, credentialId)
            .run(signal);

    readonly removeProjectControlHost = (projectId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(
                `DELETE FROM channel_host_credentials
                  WHERE credential_id = ? AND source_grant_id IS NULL AND authority = 'linked'
                    AND EXISTS (
                        SELECT 1 FROM pairing_channels
                         WHERE pairing_channels.channel_id = channel_host_credentials.channel_id
                           AND pairing_channels.project_id = ?
                    )`,
            )
            .bind(credentialId, projectId)
            .run(signal);

    readonly redeemGrant = (
        channelId: string,
        grantId: string,
        secretHash: string,
        credentialId: string,
        hostHash: string,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#database.batch(
            [
                this.#database
                    .prepare(`UPDATE channel_access_grants SET redeemed_at = ?, redeemed_credential_id = ?
            WHERE grant_id = ? AND channel_id = ? AND secret_hash = ? AND redeemed_at IS NULL AND expires_at > ?`)
                    .bind(now, credentialId, grantId, channelId, secretHash, now),
                this.#database
                    .prepare(`INSERT INTO channel_host_credentials (credential_id, channel_id, token_hash,
            authority, created_at, last_used_at, source_grant_id)
            SELECT ?, channel_id, ?, 'linked', ?, ?, grant_id FROM channel_access_grants
            WHERE grant_id = ? AND channel_id = ? AND redeemed_at = ? AND redeemed_credential_id = ?`)
                    .bind(credentialId, hostHash, now, now, grantId, channelId, now, credentialId),
            ],
            signal,
        );

    readonly readGrant = (channelId: string, grantId: string, secretHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT expires_at, CASE WHEN redeemed_at IS NULL THEN 0 ELSE 1 END AS is_redeemed FROM channel_access_grants
        WHERE grant_id = ? AND channel_id = ? AND secret_hash = ?`)
            .bind(grantId, channelId, secretHash)
            .first<{ readonly expires_at: number; readonly is_redeemed: number }>(signal);

    readonly revokeLinked = (channelId: string, credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE channel_host_credentials SET revoked_at = ? WHERE credential_id = ? AND channel_id = ?
            AND authority = 'linked' AND revoked_at IS NULL`)
            .bind(now, credentialId, channelId)
            .run(signal);

    readonly readLinked = (channelId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id FROM channel_host_credentials WHERE credential_id = ? AND channel_id = ? AND authority = 'linked'`)
            .bind(credentialId, channelId)
            .first<{ readonly credential_id: string }>(signal);

    readonly revokeBrowser = (projectId: string, credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE project_browser_credentials SET revoked_at = COALESCE(revoked_at, ?)
        WHERE credential_id = ? AND project_id = ?`)
            .bind(now, credentialId, projectId)
            .run(signal);

    readonly updateAgents = (channelId: string, tokenHash: string, agents: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE pairing_channels SET agents_json = ?
        WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`)
            .bind(agents, channelId, tokenHash)
            .run(signal);
}
