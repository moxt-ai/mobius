import {
    ACCESS_GRANT_LIFETIME_MILLISECONDS,
    type AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    type ClaimedPairing,
    CreatedBrowserCredential,
    type CreatedChannelAccessGrant,
    type CreatedPairing,
    CreatedRuntimePairing,
    createRandomPairingCode,
    createRandomToken,
    ExpiredPairingStatus,
    hashSecret,
    type InstallableAgentDescriptor,
    LinkedChannelDevice,
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MAX_RUNTIMES_PER_PROJECT,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairedPairingStatus,
    PairingDirectoryError,
    type PairingGateway,
    type PairingStatus,
    PendingPairingStatus,
    ProjectOwnerAccess,
    ProjectScopeAccess,
    parseAgents,
    parseInstallableAgents,
    type RedeemedChannelAccessGrant,
    RevokedPairingStatus,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
    validateIdentifier,
    validateToken,
} from "@moxt-ai/mobius-relay-core";
import type { DatabaseResolver } from "./database-resolver.ts";
import type { PairingIdentityCredential, PairingIdentityDirectory } from "./pairing-identity-directory.ts";
import type { TenantShardingDirectory } from "./tenant-sharding-directory.ts";

interface PairingChannelRow {
    readonly agents_json: string;
    readonly channel_id: string;
    readonly expires_at: number;
    readonly installable_agents_json: string;
    readonly machine_name: string;
    readonly pairing_id: string;
    readonly project_id: string;
    readonly revoked_at: unknown;
    readonly runtime_id: string;
    readonly status: string;
    readonly tenant_id: string;
    readonly workspace_name: string;
}

interface RuntimePairingRow {
    readonly channel_id: string;
    readonly created_by_owner_credential_id: unknown;
    readonly expires_at: number;
    readonly pairing_code_hash: string;
    readonly pairing_id: string;
    readonly poll_token_hash: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
}

interface ChannelScopeRow {
    readonly channel_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
}

interface RuntimeScopeRow extends ChannelScopeRow {
    readonly status: string;
}

interface RevocableRuntimeRow extends RuntimeScopeRow {
    readonly pairing_id: string;
    readonly revoked_at: unknown;
}

interface AuthorizedChannelRow extends ChannelScopeRow {
    readonly credential_id: string;
    readonly authority: string;
}

interface AccessGrantStateRow {
    readonly expires_at: number;
    readonly is_redeemed: number;
}

interface LinkedChannelDeviceRow {
    readonly created_at: number;
    readonly credential_id: string;
    readonly last_used_at: number;
}

interface RedeemedChannelRow {
    readonly project_id: string;
    readonly tenant_id: string;
}

interface PublicChannelRow {
    readonly agents_json: string;
    readonly channel_id: string;
    readonly installable_agents_json: string;
    readonly machine_name: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
    readonly workspace_name: string;
}

interface BrowserCredentialRow {
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly revoked_at: unknown;
    readonly tenant_id: string;
}

interface ProjectOwnerCredentialRow {
    readonly credential_id: string;
    readonly project_id: string;
    readonly tenant_id: string;
}

interface ExpiredPairingRow {
    readonly pairing_id: string;
    readonly runtime_id: string;
}

class DerivedRuntimePairingSecrets {
    readonly pairingCode: string;
    readonly pollToken: string;

    constructor(pairingCode: string, pollToken: string) {
        this.pairingCode = pairingCode;
        this.pollToken = pollToken;
    }
}

const RUNTIME_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RUNTIME_SLOT_VALUES = Array.from(
    { length: MAX_RUNTIMES_PER_PROJECT },
    (_, index) => `(${(index + 1).toString()})`,
).join(", ");

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function deriveRuntimePairingSecret(
    ownerToken: string,
    projectId: string,
    idempotencyKey: string,
    purpose: string,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(validateToken(ownerToken)),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${purpose}\u0000${projectId}\u0000${idempotencyKey}`),
        ),
    );
}

async function deriveRuntimePairingSecrets(
    ownerToken: string,
    projectId: string,
    idempotencyKey: string,
): Promise<DerivedRuntimePairingSecrets> {
    const codeBytes = await deriveRuntimePairingSecret(ownerToken, projectId, idempotencyKey, "pairing-code");
    let code = "";
    for (const byte of codeBytes.slice(0, 20)) {
        code += RUNTIME_PAIRING_CODE_ALPHABET.charAt(byte % RUNTIME_PAIRING_CODE_ALPHABET.length);
    }
    const pairingCode = code.match(/.{1,4}/g)?.join("-") ?? code;
    const pollToken = base64Url(await deriveRuntimePairingSecret(ownerToken, projectId, idempotencyKey, "poll-token"));
    return new DerivedRuntimePairingSecrets(pairingCode, pollToken);
}

export class D1PairingGateway implements PairingGateway {
    private readonly databases: DatabaseResolver;
    private readonly tenants: TenantShardingDirectory;
    private readonly identities: PairingIdentityDirectory;

    constructor(cx: {
        readonly gateways: {
            readonly databaseResolver: DatabaseResolver;
            readonly tenantShardingDirectory: TenantShardingDirectory;
            readonly pairingIdentityDirectory: PairingIdentityDirectory;
        };
    }) {
        this.databases = cx.gateways.databaseResolver;
        this.tenants = cx.gateways.tenantShardingDirectory;
        this.identities = cx.gateways.pairingIdentityDirectory;
    }

    private readonly identityDatabase = async (
        credential: PairingIdentityCredential,
        signal: AbortSignal,
    ): Promise<D1Database> => {
        const identity = await this.identities.authenticate(credential, signal);
        const tenant = await this.tenants.resolve(identity.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        if (database !== identity.database) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return database;
    };

    private readonly audit = (
        database: D1Database,
        tenantId: string,
        projectId: string,
        pairingId: string,
        runtimeId: string,
        actorKind: string,
        actorId: string,
        action: string,
        details: Readonly<Record<string, string>>,
        recordedAt: number,
    ): D1PreparedStatement =>
        database
            .prepare(
                `INSERT OR IGNORE INTO runtime_pairing_audit_events (
                   audit_id, tenant_id, project_id, pairing_id, runtime_id,
                   actor_kind, actor_id, action, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                `rpa_${crypto.randomUUID()}`,
                tenantId,
                projectId,
                pairingId,
                runtimeId,
                actorKind,
                actorId,
                action,
                JSON.stringify(details),
                recordedAt,
            );

    private readonly expireProjectPairings = async (
        database: D1Database,
        tenantId: string,
        projectId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const expired = await database
            .prepare(
                `UPDATE pairing_channels
                    SET status = 'expired'
                  WHERE tenant_id = ? AND project_id = ?
                    AND status = 'pending' AND expires_at <= ?
                  RETURNING pairing_id, runtime_id`,
            )
            .bind(tenantId, projectId, now)
            .all<ExpiredPairingRow>();
        signal.throwIfAborted();
        if (expired.results.length === 0) {
            return;
        }
        await database.batch(
            expired.results.map((row) =>
                this.audit(
                    database,
                    tenantId,
                    projectId,
                    row.pairing_id,
                    row.runtime_id,
                    "system",
                    "relay",
                    "runtime_pairing.expired",
                    {},
                    now,
                ),
            ),
        );
        signal.throwIfAborted();
    };

    private readonly readProjectRuntime = async (
        database: D1Database,
        access: ProjectScopeAccess,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<VerifiedChannelAccess> => {
        const row = await database
            .prepare(
                `SELECT channel_id, runtime_id, tenant_id, project_id, status
                   FROM pairing_channels
                  WHERE tenant_id = ? AND project_id = ? AND runtime_id = ?`,
            )
            .bind(access.tenantId, access.projectId, validateIdentifier(runtimeId, "runtime_id"))
            .first<RuntimeScopeRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        if (row.status !== "paired") {
            throw new PairingDirectoryError("runtime_unavailable", "The selected Runtime is unavailable");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    private readonly decodeCreatedRuntimePairing = async (
        row: RuntimePairingRow,
        owner: ProjectOwnerAccess,
        ownerToken: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedRuntimePairing> => {
        if (
            row.tenant_id !== owner.tenantId ||
            row.project_id !== owner.projectId ||
            row.created_by_owner_credential_id !== owner.credentialId
        ) {
            throw new PairingDirectoryError(
                "idempotency_conflict",
                "The Runtime pairing idempotency key belongs to another owner request",
            );
        }
        const secrets = await deriveRuntimePairingSecrets(ownerToken, owner.projectId, idempotencyKey);
        signal.throwIfAborted();
        if (
            row.pairing_code_hash !== (await hashSecret(secrets.pairingCode)) ||
            row.poll_token_hash !== (await hashSecret(secrets.pollToken))
        ) {
            throw new PairingDirectoryError("invalid_directory_record", "The Runtime pairing directory is invalid");
        }
        return new CreatedRuntimePairing(
            row.channel_id,
            new Date(row.expires_at).toISOString(),
            secrets.pairingCode,
            row.pairing_id,
            secrets.pollToken,
            row.project_id,
            row.runtime_id,
        );
    };

    private readonly decodePairingStatus = async (
        database: D1Database,
        row: PairingChannelRow,
        signal: AbortSignal,
    ): Promise<PairingStatus> => {
        if (row.status === "paired") {
            return new PairedPairingStatus(
                parseAgents(row.agents_json),
                row.channel_id,
                row.machine_name,
                row.workspace_name,
                row.tenant_id,
                row.project_id,
                row.runtime_id,
                parseInstallableAgents(row.installable_agents_json),
            );
        }
        if (row.status === "revoked") {
            if (typeof row.revoked_at !== "number" || !Number.isSafeInteger(row.revoked_at)) {
                throw new PairingDirectoryError("invalid_directory_record", "The pairing status is invalid");
            }
            return new RevokedPairingStatus(new Date(row.revoked_at).toISOString());
        }
        const now = Date.now();
        if (row.status === "expired" || (row.status === "pending" && row.expires_at <= now)) {
            if (row.status === "pending") {
                await database.batch([
                    database
                        .prepare(
                            `UPDATE pairing_channels SET status = 'expired'
                              WHERE pairing_id = ? AND status = 'pending' AND expires_at <= ?`,
                        )
                        .bind(row.pairing_id, now),
                    database
                        .prepare(
                            `INSERT OR IGNORE INTO runtime_pairing_audit_events (
                               audit_id, tenant_id, project_id, pairing_id, runtime_id,
                               actor_kind, actor_id, action, details_json, recorded_at
                             )
                             SELECT ?, tenant_id, project_id, pairing_id, runtime_id,
                                    'system', 'relay', 'runtime_pairing.expired', '{}', ?
                               FROM pairing_channels
                              WHERE pairing_id = ? AND status = 'expired'`,
                        )
                        .bind(`rpa_${crypto.randomUUID()}`, now, row.pairing_id),
                ]);
                signal.throwIfAborted();
            }
            return new ExpiredPairingStatus();
        }
        if (row.status !== "pending") {
            throw new PairingDirectoryError("invalid_directory_record", "The pairing status is invalid");
        }
        return new PendingPairingStatus(new Date(row.expires_at).toISOString());
    };

    private readonly readAuthorizedHost = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const database = await this.identityDatabase({ kind: "host", channelId, tokenHash }, signal);
        const row = await database
            .prepare(
                `SELECT channels.channel_id,
                channels.runtime_id,
                channels.tenant_id,
                channels.project_id,
                credentials.credential_id,
                credentials.authority
         FROM pairing_channels AS channels
         INNER JOIN channel_host_credentials AS credentials
           ON credentials.channel_id = channels.channel_id
         WHERE channels.channel_id = ?
           AND credentials.token_hash = ?
           AND credentials.revoked_at IS NULL
           AND channels.status = 'paired'`,
            )
            .bind(validateIdentifier(channelId, "channel_id"), tokenHash)
            .first<AuthorizedChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        const touched = await database
            .prepare(
                `UPDATE channel_host_credentials
         SET last_used_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL`,
            )
            .bind(Date.now(), row.credential_id)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        return row;
    };

    private readonly readAuthorizedOwner = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        const row = await this.readAuthorizedHost(channelId, token, signal);
        if (row.authority !== "owner") {
            throw new PairingDirectoryError(
                "owner_access_required",
                "Only the channel owner can manage linked devices",
            );
        }
        return row;
    };

    private readonly readAuthorizedProjectOwner = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ProjectOwnerAccess> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const database = await this.identityDatabase({ kind: "project", projectId, tokenHash }, signal);
        const row = await database
            .prepare(
                `SELECT credential_id, tenant_id, project_id
                   FROM project_owner_credentials
                  WHERE project_id = ? AND token_hash = ? AND revoked_at IS NULL`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<ProjectOwnerCredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("owner_access_required", "An owner app credential is required");
        }
        const touched = await database
            .prepare(
                `UPDATE project_owner_credentials
                    SET last_used_at = ?
                  WHERE credential_id = ? AND revoked_at IS NULL`,
            )
            .bind(Date.now(), row.credential_id)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new PairingDirectoryError("owner_access_required", "An owner app credential is required");
        }
        return new ProjectOwnerAccess(row.tenant_id, row.project_id, row.credential_id);
    };

    private readonly authorizeBrowserProject = async (
        database: D1Database,
        projectId: string,
        tokenHash: string,
        signal: AbortSignal,
    ): Promise<ProjectScopeAccess> => {
        const row = await database
            .prepare(
                `SELECT credential_id, tenant_id, project_id, expires_at, revoked_at
         FROM project_browser_credentials
         WHERE project_id = ? AND token_hash = ?`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<BrowserCredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid project credential is required");
        }
        if (row.revoked_at !== null) {
            throw new PairingDirectoryError("credential_revoked", "The browser credential was revoked");
        }
        const now = Date.now();
        if (row.expires_at <= now) {
            throw new PairingDirectoryError("credential_expired", "The browser credential expired");
        }
        const touched = await database
            .prepare(
                `UPDATE project_browser_credentials
         SET last_used_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
            )
            .bind(now, row.credential_id, now)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project credential is required");
        }
        return new ProjectScopeAccess(row.tenant_id, row.project_id);
    };

    readonly authorizeDaemon = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<VerifiedChannelAccess> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const database = await this.identityDatabase({ kind: "daemon", channelId, tokenHash }, signal);
        const row = await database
            .prepare(
                `SELECT channel_id, runtime_id, tenant_id, project_id FROM pairing_channels
         WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`,
            )
            .bind(channelId, tokenHash)
            .first<ChannelScopeRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        if (row.channel_id !== channelId) {
            throw new PairingDirectoryError("invalid_directory_record", "The channel directory is invalid");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    readonly authorizeHost = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ChannelHostCredential> => {
        const row = await this.readAuthorizedHost(channelId, token, signal);
        return new ChannelHostCredential(
            row.channel_id,
            row.runtime_id,
            row.tenant_id,
            row.project_id,
            row.credential_id,
        );
    };

    readonly authorizeProject = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ProjectScopeAccess> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const database = await this.identityDatabase({ kind: "project", projectId, tokenHash }, signal);
        const owner = await database
            .prepare(
                `SELECT credential_id, tenant_id, project_id
                   FROM project_owner_credentials
                  WHERE project_id = ? AND token_hash = ? AND revoked_at IS NULL`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<ProjectOwnerCredentialRow>();
        signal.throwIfAborted();
        if (owner !== null) {
            const touched = await database
                .prepare(
                    `UPDATE project_owner_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL`,
                )
                .bind(Date.now(), owner.credential_id)
                .run();
            signal.throwIfAborted();
            if (touched.meta.changes !== 1) {
                throw new PairingDirectoryError("unauthorized", "A valid project token is required");
            }
            return new ProjectScopeAccess(owner.tenant_id, owner.project_id);
        }
        const row = await database
            .prepare(
                `SELECT channels.channel_id,
                channels.runtime_id,
                channels.tenant_id,
                channels.project_id,
                credentials.credential_id,
                credentials.authority
         FROM pairing_channels AS channels
         INNER JOIN channel_host_credentials AS credentials
           ON credentials.channel_id = channels.channel_id
         WHERE channels.project_id = ?
           AND credentials.token_hash = ?
           AND credentials.revoked_at IS NULL
           AND channels.status = 'paired'`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<AuthorizedChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            return await this.authorizeBrowserProject(database, projectId, tokenHash, signal);
        }
        const touched = await database
            .prepare(
                `UPDATE channel_host_credentials
         SET last_used_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL`,
            )
            .bind(Date.now(), row.credential_id)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project token is required");
        }
        return new ProjectScopeAccess(row.tenant_id, row.project_id);
    };

    readonly authorizeProjectRuntime = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<VerifiedChannelAccess> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const database = await this.identityDatabase({ kind: "project", projectId, tokenHash }, signal);
        const owner = await database
            .prepare(
                `SELECT credential_id, tenant_id, project_id
                   FROM project_owner_credentials
                  WHERE project_id = ? AND token_hash = ? AND revoked_at IS NULL`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<ProjectOwnerCredentialRow>();
        signal.throwIfAborted();
        if (owner !== null) {
            const touched = await database
                .prepare(
                    `UPDATE project_owner_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL`,
                )
                .bind(Date.now(), owner.credential_id)
                .run();
            signal.throwIfAborted();
            if (touched.meta.changes !== 1) {
                throw new PairingDirectoryError("unauthorized", "A valid project Runtime credential is required");
            }
            return await this.readProjectRuntime(
                database,
                new ProjectScopeAccess(owner.tenant_id, owner.project_id),
                runtimeId,
                signal,
            );
        }
        const row = await database
            .prepare(
                `SELECT channels.channel_id,
                channels.runtime_id,
                channels.tenant_id,
                channels.project_id,
                credentials.credential_id,
                credentials.authority
         FROM pairing_channels AS channels
         INNER JOIN channel_host_credentials AS credentials
           ON credentials.channel_id = channels.channel_id
         WHERE channels.project_id = ?
           AND channels.runtime_id = ?
           AND credentials.token_hash = ?
           AND credentials.revoked_at IS NULL
           AND channels.status = 'paired'`,
            )
            .bind(validateIdentifier(projectId, "project_id"), validateIdentifier(runtimeId, "runtime_id"), tokenHash)
            .first<AuthorizedChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            const browser = await this.authorizeBrowserProject(database, projectId, tokenHash, signal);
            return await this.readProjectRuntime(database, browser, runtimeId, signal);
        }
        const touched = await database
            .prepare(
                `UPDATE channel_host_credentials
         SET last_used_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL`,
            )
            .bind(Date.now(), row.credential_id)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project Runtime credential is required");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    readonly claimPairing = async (
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> => {
        signal.throwIfAborted();
        const daemonToken = createRandomToken(32);
        const now = Date.now();
        const codeHash = await hashSecret(normalizePairingCode(pairingCode));
        const database = await this.identityDatabase({ kind: "pairing-code", codeHash }, signal);
        const pairing = await database
            .prepare(
                `SELECT pairing_id, status, channel_id, runtime_id, expires_at, machine_name, workspace_name,
                        agents_json, installable_agents_json, tenant_id, project_id, revoked_at
                   FROM pairing_channels
                  WHERE pairing_code_hash = ?`,
            )
            .bind(codeHash)
            .first<PairingChannelRow>();
        signal.throwIfAborted();
        if (pairing === null) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        const daemonTokenHash = await hashSecret(daemonToken);
        if (pairing.status === "pending" && pairing.expires_at > now) {
            const claimed = await database.batch([
                database
                    .prepare(
                        `UPDATE pairing_channels
                            SET status = 'paired', daemon_token_hash = ?, claimed_at = ?,
                                machine_name = ?, workspace_name = ?, agents_json = ?,
                                installable_agents_json = ?
                          WHERE pairing_code_hash = ? AND status = 'pending' AND expires_at > ?`,
                    )
                    .bind(
                        daemonTokenHash,
                        now,
                        machineName,
                        workspaceName,
                        JSON.stringify(agents),
                        JSON.stringify(installableAgents),
                        codeHash,
                        now,
                    ),
                database
                    .prepare(
                        `INSERT OR IGNORE INTO runtime_pairing_audit_events (
                           audit_id, tenant_id, project_id, pairing_id, runtime_id,
                           actor_kind, actor_id, action, details_json, recorded_at
                         )
                         SELECT ?, tenant_id, project_id, pairing_id, runtime_id,
                                'runtime', runtime_id, 'runtime_pairing.claimed', '{}', ?
                           FROM pairing_channels
                          WHERE pairing_code_hash = ? AND status = 'paired'
                            AND daemon_token_hash = ? AND claimed_at = ?`,
                    )
                    .bind(`rpa_${crypto.randomUUID()}`, now, codeHash, daemonTokenHash, now),
            ]);
            signal.throwIfAborted();
            if (claimed[0]?.meta.changes === 1) {
                return {
                    channelId: pairing.channel_id,
                    daemonToken,
                    runtimeId: pairing.runtime_id,
                };
            }
        }

        const current = await database
            .prepare(
                `SELECT pairing_id, status, channel_id, runtime_id, expires_at, machine_name, workspace_name,
                        agents_json, installable_agents_json, tenant_id, project_id, revoked_at
                   FROM pairing_channels
                  WHERE pairing_code_hash = ?`,
            )
            .bind(codeHash)
            .first<PairingChannelRow>();
        signal.throwIfAborted();
        if (current !== null && current.status === "pending" && current.expires_at <= now) {
            await database.batch([
                database
                    .prepare(
                        `UPDATE pairing_channels SET status = 'expired'
                          WHERE pairing_code_hash = ? AND status = 'pending' AND expires_at <= ?`,
                    )
                    .bind(codeHash, now),
                database
                    .prepare(
                        `INSERT OR IGNORE INTO runtime_pairing_audit_events (
                           audit_id, tenant_id, project_id, pairing_id, runtime_id,
                           actor_kind, actor_id, action, details_json, recorded_at
                         )
                         SELECT ?, tenant_id, project_id, pairing_id, runtime_id,
                                'system', 'relay', 'runtime_pairing.expired', '{}', ?
                           FROM pairing_channels
                          WHERE pairing_code_hash = ? AND status = 'expired'`,
                    )
                    .bind(`rpa_${crypto.randomUUID()}`, now, codeHash),
            ]);
            signal.throwIfAborted();
        }
        await database
            .prepare(
                `INSERT INTO runtime_pairing_audit_events (
                   audit_id, tenant_id, project_id, pairing_id, runtime_id,
                   actor_kind, actor_id, action, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, 'pairing_code', ?, 'runtime_pairing.rejected', ?, ?)`,
            )
            .bind(
                `rpa_${crypto.randomUUID()}`,
                pairing.tenant_id,
                pairing.project_id,
                pairing.pairing_id,
                pairing.pairing_id,
                pairing.runtime_id,
                JSON.stringify({ code: "invalid_pairing_code" }),
                now,
            )
            .run();
        signal.throwIfAborted();
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    };

    readonly createChannelAccessGrant = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<CreatedChannelAccessGrant> => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        signal.throwIfAborted();
        const now = Date.now();
        const grantId = `grt_${createRandomToken(18)}`;
        const grantSecret = createRandomToken(32);
        const expiresAt = now + ACCESS_GRANT_LIFETIME_MILLISECONDS;
        const tenant = await this.tenants.resolve(owner.tenant_id, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const result = await database
            .prepare(
                `INSERT INTO channel_access_grants (
           grant_id,
           channel_id,
           secret_hash,
           created_by_credential_id,
           created_at,
           expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(grantId, owner.channel_id, await hashSecret(grantSecret), owner.credential_id, now, expiresAt)
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new Error("The access grant was not stored");
        }
        return {
            expiresAt: new Date(expiresAt).toISOString(),
            grantId,
            grantSecret,
        };
    };

    readonly createBrowserCredential = async (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ): Promise<CreatedBrowserCredential> => {
        if (
            !Number.isSafeInteger(lifetimeMilliseconds) ||
            lifetimeMilliseconds < MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS ||
            lifetimeMilliseconds > MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS
        ) {
            throw new PairingDirectoryError("invalid_request", "The browser credential lifetime is invalid");
        }
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const now = Date.now();
        const expiresAt = now + lifetimeMilliseconds;
        const credentialId = `bcr_${createRandomToken(18)}`;
        const browserToken = createRandomToken(32);
        const tenant = await this.tenants.resolve(owner.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const result = await database
            .prepare(
                `INSERT INTO project_browser_credentials (
           credential_id, tenant_id, project_id, token_hash,
           created_by_credential_id, created_at, expires_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                credentialId,
                owner.tenantId,
                owner.projectId,
                await hashSecret(browserToken),
                owner.credentialId,
                now,
                expiresAt,
                now,
            )
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new Error("The browser credential was not stored");
        }
        return new CreatedBrowserCredential(
            credentialId,
            new Date(expiresAt).toISOString(),
            owner.projectId,
            owner.tenantId,
            browserToken,
        );
    };

    readonly createProjectRuntimePairing = async (
        projectId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedRuntimePairing> => {
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.readAuthorizedProjectOwner(normalizedProjectId, token, signal);
        const tenant = await this.tenants.resolve(owner.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const now = Date.now();
        await this.expireProjectPairings(database, owner.tenantId, owner.projectId, now, signal);
        const existing = await database
            .prepare(
                `SELECT pairing_id, pairing_code_hash, poll_token_hash, channel_id, runtime_id,
                        tenant_id, project_id, expires_at, created_by_owner_credential_id
                   FROM pairing_channels
                  WHERE tenant_id = ? AND project_id = ? AND creation_idempotency_key = ?`,
            )
            .bind(owner.tenantId, owner.projectId, normalizedIdempotencyKey)
            .first<RuntimePairingRow>();
        signal.throwIfAborted();
        if (existing !== null) {
            return await this.decodeCreatedRuntimePairing(existing, owner, token, normalizedIdempotencyKey, signal);
        }

        const secrets = await deriveRuntimePairingSecrets(token, owner.projectId, normalizedIdempotencyKey);
        const pairingId = crypto.randomUUID();
        const channelId = `chn_${createRandomToken(18)}`;
        const runtimeId = `rnt_${createRandomToken(18)}`;
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        try {
            const results = await database.batch([
                database
                    .prepare(
                        `WITH runtime_slots(runtime_slot) AS (VALUES ${RUNTIME_SLOT_VALUES})
                         INSERT INTO pairing_channels (
                           pairing_id, pairing_code_hash, poll_token_hash, channel_id,
                           runtime_id, tenant_id, project_id, status, created_at,
                           expires_at, creation_idempotency_key,
                           created_by_owner_credential_id, runtime_slot
                         )
                         SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, runtime_slot
                           FROM runtime_slots
                          WHERE NOT EXISTS (
                            SELECT 1 FROM pairing_channels AS active
                             WHERE active.tenant_id = ? AND active.project_id = ?
                               AND active.runtime_slot = runtime_slots.runtime_slot
                               AND active.status IN ('pending', 'paired')
                          )
                          ORDER BY runtime_slot
                          LIMIT 1`,
                    )
                    .bind(
                        pairingId,
                        await hashSecret(secrets.pairingCode),
                        await hashSecret(secrets.pollToken),
                        channelId,
                        runtimeId,
                        owner.tenantId,
                        owner.projectId,
                        now,
                        expiresAt,
                        normalizedIdempotencyKey,
                        owner.credentialId,
                        owner.tenantId,
                        owner.projectId,
                    ),
                database
                    .prepare(
                        `INSERT OR IGNORE INTO runtime_pairing_audit_events (
                           audit_id, tenant_id, project_id, pairing_id, runtime_id,
                           actor_kind, actor_id, action, details_json, recorded_at
                         )
                         SELECT ?, tenant_id, project_id, pairing_id, runtime_id,
                                'owner', ?, 'runtime_pairing.requested', ?, ?
                           FROM pairing_channels WHERE pairing_id = ?`,
                    )
                    .bind(
                        `rpa_${crypto.randomUUID()}`,
                        owner.credentialId,
                        JSON.stringify({ idempotencyKey: normalizedIdempotencyKey }),
                        now,
                        pairingId,
                    ),
            ]);
            signal.throwIfAborted();
            if (results[0]?.meta.changes !== 1) {
                throw new PairingDirectoryError(
                    "runtime_quota_exceeded",
                    `A Project can have at most ${MAX_RUNTIMES_PER_PROJECT.toString()} active Runtimes`,
                );
            }
            return new CreatedRuntimePairing(
                channelId,
                new Date(expiresAt).toISOString(),
                secrets.pairingCode,
                pairingId,
                secrets.pollToken,
                owner.projectId,
                runtimeId,
            );
        } catch (cause) {
            signal.throwIfAborted();
            const duplicate = await database
                .prepare(
                    `SELECT pairing_id, pairing_code_hash, poll_token_hash, channel_id, runtime_id,
                            tenant_id, project_id, expires_at, created_by_owner_credential_id
                       FROM pairing_channels
                      WHERE tenant_id = ? AND project_id = ? AND creation_idempotency_key = ?`,
                )
                .bind(owner.tenantId, owner.projectId, normalizedIdempotencyKey)
                .first<RuntimePairingRow>();
            signal.throwIfAborted();
            if (duplicate !== null) {
                return await this.decodeCreatedRuntimePairing(
                    duplicate,
                    owner,
                    token,
                    normalizedIdempotencyKey,
                    signal,
                );
            }
            const quota = await database
                .prepare(
                    `SELECT COUNT(*) AS active_count
                       FROM pairing_channels
                      WHERE tenant_id = ? AND project_id = ?
                        AND status IN ('pending', 'paired')`,
                )
                .bind(owner.tenantId, owner.projectId)
                .first<{ readonly active_count: number }>();
            signal.throwIfAborted();
            if (quota !== null && quota.active_count >= MAX_RUNTIMES_PER_PROJECT) {
                await this.audit(
                    database,
                    owner.tenantId,
                    owner.projectId,
                    pairingId,
                    runtimeId,
                    "owner",
                    owner.credentialId,
                    "runtime_pairing.rejected",
                    { code: "runtime_quota_exceeded" },
                    now,
                ).run();
                signal.throwIfAborted();
                throw new PairingDirectoryError(
                    "runtime_quota_exceeded",
                    `A Project can have at most ${MAX_RUNTIMES_PER_PROJECT.toString()} active Runtimes`,
                    { cause },
                );
            }
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            throw new PairingDirectoryError("directory_unavailable", "The Runtime pairing could not be stored", {
                cause,
            });
        }
    };

    readonly createPairing = async (tenantId: string, signal: AbortSignal): Promise<CreatedPairing> => {
        signal.throwIfAborted();
        validateIdentifier(tenantId, "tenant_id");
        const tenant = await this.tenants.resolve(tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const now = Date.now();
        const pairingId = crypto.randomUUID();
        const pairingCode = createRandomPairingCode();
        const pollToken = createRandomToken(32);
        const hostToken = createRandomToken(32);
        const ownerCredentialId = `hcr_${createRandomToken(18)}`;
        const channelId = `chn_${createRandomToken(18)}`;
        const runtimeId = `rnt_${createRandomToken(18)}`;
        const projectId = `prj_${createRandomToken(18)}`;
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;

        const results = await database.batch([
            database
                .prepare(
                    `INSERT INTO pairing_channels (
          pairing_id,
          pairing_code_hash,
          poll_token_hash,
          channel_id,
          runtime_id,
          tenant_id,
          project_id,
          status,
          created_at,
          expires_at,
          runtime_slot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`,
                )
                .bind(
                    pairingId,
                    await hashSecret(pairingCode),
                    await hashSecret(pollToken),
                    channelId,
                    runtimeId,
                    tenantId,
                    projectId,
                    now,
                    expiresAt,
                ),
            database
                .prepare(
                    `INSERT INTO channel_host_credentials (
             credential_id,
             channel_id,
             token_hash,
             authority,
             created_at,
             last_used_at
           ) VALUES (?, ?, ?, 'owner', ?, ?)`,
                )
                .bind(ownerCredentialId, channelId, await hashSecret(hostToken), now, now),
            database
                .prepare(
                    `INSERT INTO project_owner_credentials (
                       credential_id, tenant_id, project_id, token_hash,
                       source_channel_id, created_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(ownerCredentialId, tenantId, projectId, await hashSecret(hostToken), channelId, now, now),
            this.audit(
                database,
                tenantId,
                projectId,
                pairingId,
                runtimeId,
                "bootstrap",
                tenantId,
                "runtime_pairing.requested",
                {},
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new Error("The pairing credentials were not stored");
        }

        return {
            channelId,
            expiresAt: new Date(expiresAt).toISOString(),
            hostToken,
            pairingCode,
            pairingId,
            pollToken,
            projectId,
            runtimeId,
            tenantId,
        };
    };

    readonly listLinkedChannelDevices = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<readonly LinkedChannelDevice[]> => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const tenant = await this.tenants.resolve(owner.tenant_id, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const page = await database
            .prepare(
                `SELECT credential_id, created_at, last_used_at
         FROM channel_host_credentials
         WHERE channel_id = ?
           AND authority = 'linked'
           AND revoked_at IS NULL
         ORDER BY created_at DESC, credential_id DESC`,
            )
            .bind(owner.channel_id)
            .all<LinkedChannelDeviceRow>();
        signal.throwIfAborted();
        return page.results.map(
            (row) =>
                new LinkedChannelDevice(
                    row.credential_id,
                    new Date(row.created_at).toISOString(),
                    new Date(row.last_used_at).toISOString(),
                ),
        );
    };

    readonly listProjectRuntimes = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<readonly ChannelDescriptor[]> => {
        const access = await this.authorizeProject(projectId, token, signal);
        const tenant = await this.tenants.resolve(access.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const page = await database
            .prepare(
                `SELECT channel_id, runtime_id, machine_name, workspace_name,
                agents_json, installable_agents_json, tenant_id, project_id
         FROM pairing_channels
         WHERE tenant_id = ? AND project_id = ? AND status = 'paired'
         ORDER BY created_at, channel_id
         LIMIT 100`,
            )
            .bind(access.tenantId, access.projectId)
            .all<PublicChannelRow>();
        signal.throwIfAborted();
        return page.results.map(
            (row) =>
                new ChannelDescriptor(
                    parseAgents(row.agents_json),
                    row.channel_id,
                    row.machine_name,
                    row.workspace_name,
                    row.tenant_id,
                    row.project_id,
                    row.runtime_id,
                    parseInstallableAgents(row.installable_agents_json),
                ),
        );
    };

    readonly readChannel = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ChannelDescriptor> => {
        const access = await this.readAuthorizedHost(channelId, token, signal);
        const tenant = await this.tenants.resolve(access.tenant_id, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const row = await database
            .prepare(
                `SELECT channel_id, runtime_id, machine_name, workspace_name, agents_json,
                installable_agents_json, tenant_id, project_id
         FROM pairing_channels
         WHERE channel_id = ? AND status = 'paired'`,
            )
            .bind(access.channel_id)
            .first<PublicChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        if (row.channel_id !== channelId) {
            throw new PairingDirectoryError("invalid_directory_record", "The channel directory is invalid");
        }
        return new ChannelDescriptor(
            parseAgents(row.agents_json),
            row.channel_id,
            row.machine_name,
            row.workspace_name,
            row.tenant_id,
            row.project_id,
            row.runtime_id,
            parseInstallableAgents(row.installable_agents_json),
        );
    };

    readonly readPairingStatus = async (
        pairingId: string,
        pollToken: string,
        signal: AbortSignal,
    ): Promise<PairingStatus> => {
        signal.throwIfAborted();
        const database = await this.identityDatabase(
            { kind: "pairing", pairingId, tokenHash: await hashSecret(pollToken) },
            signal,
        );
        const row = await database
            .prepare(
                `SELECT pairing_id, status, channel_id, runtime_id, expires_at, machine_name, workspace_name,
                agents_json, installable_agents_json, tenant_id, project_id, revoked_at
         FROM pairing_channels
         WHERE pairing_id = ? AND poll_token_hash = ?`,
            )
            .bind(pairingId, await hashSecret(pollToken))
            .first<PairingChannelRow>();
        signal.throwIfAborted();

        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The pairing request was not found");
        }
        return await this.decodePairingStatus(database, row, signal);
    };

    readonly readProjectRuntimePairing = async (
        projectId: string,
        pairingId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<PairingStatus> => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const tenant = await this.tenants.resolve(owner.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const row = await database
            .prepare(
                `SELECT pairing_id, status, channel_id, runtime_id, expires_at, machine_name, workspace_name,
                        agents_json, installable_agents_json, tenant_id, project_id, revoked_at
                   FROM pairing_channels
                  WHERE tenant_id = ? AND project_id = ? AND pairing_id = ?`,
            )
            .bind(owner.tenantId, owner.projectId, validateIdentifier(pairingId, "pairing_id"))
            .first<PairingChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Runtime pairing request was not found");
        }
        return await this.decodePairingStatus(database, row, signal);
    };

    readonly redeemChannelAccessGrant = async (
        channelId: string,
        grantId: string,
        grantSecret: string,
        signal: AbortSignal,
    ): Promise<RedeemedChannelAccessGrant> => {
        signal.throwIfAborted();
        const normalizedChannelId = validateIdentifier(channelId, "channel_id");
        const normalizedGrantId = validateIdentifier(grantId, "grant_id");
        const secretHash = await hashSecret(validateToken(grantSecret));
        signal.throwIfAborted();
        const now = Date.now();
        const credentialId = `hcr_${createRandomToken(18)}`;
        const hostToken = createRandomToken(32);
        const database = await this.identityDatabase({ kind: "grant", channelId, grantId, secretHash }, signal);
        const results = await database.batch([
            database
                .prepare(
                    `UPDATE channel_access_grants
           SET redeemed_at = ?, redeemed_credential_id = ?
           WHERE grant_id = ?
             AND channel_id = ?
             AND secret_hash = ?
             AND redeemed_at IS NULL
             AND expires_at > ?`,
                )
                .bind(now, credentialId, normalizedGrantId, normalizedChannelId, secretHash, now),
            database
                .prepare(
                    `INSERT INTO channel_host_credentials (
             credential_id,
             channel_id,
             token_hash,
             authority,
             created_at,
             last_used_at,
             source_grant_id
           )
           SELECT ?, channel_id, ?, 'linked', ?, ?, grant_id
           FROM channel_access_grants
           WHERE grant_id = ?
             AND channel_id = ?
             AND redeemed_at = ?
             AND redeemed_credential_id = ?`,
                )
                .bind(
                    credentialId,
                    await hashSecret(hostToken),
                    now,
                    now,
                    normalizedGrantId,
                    normalizedChannelId,
                    now,
                    credentialId,
                ),
        ]);
        signal.throwIfAborted();

        if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
            const state = await database
                .prepare(
                    `SELECT expires_at,
                  CASE WHEN redeemed_at IS NULL THEN 0 ELSE 1 END AS is_redeemed
           FROM channel_access_grants
           WHERE grant_id = ? AND channel_id = ? AND secret_hash = ?`,
                )
                .bind(normalizedGrantId, normalizedChannelId, secretHash)
                .first<AccessGrantStateRow>();
            signal.throwIfAborted();
            if (state === null) {
                throw new PairingDirectoryError("access_grant_invalid", "The access link is invalid");
            }
            if (state.is_redeemed === 1) {
                throw new PairingDirectoryError("access_grant_redeemed", "The access link has already been used");
            }
            if (state.expires_at <= now) {
                throw new PairingDirectoryError("access_grant_expired", "The access link has expired");
            }
            throw new Error("The access grant could not be redeemed");
        }

        const channel = await database
            .prepare(
                `SELECT tenant_id, project_id
         FROM pairing_channels
         WHERE channel_id = ? AND status = 'paired'`,
            )
            .bind(normalizedChannelId)
            .first<RedeemedChannelRow>();
        signal.throwIfAborted();
        if (channel === null) {
            throw new Error("The redeemed channel directory is invalid");
        }
        return {
            channelId: normalizedChannelId,
            hostToken,
            projectId: channel.project_id,
            tenantId: channel.tenant_id,
        };
    };

    readonly revokeLinkedChannelDevice = async (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ChannelHostCredential> => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const tenant = await this.tenants.resolve(owner.tenant_id, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const result = await database
            .prepare(
                `UPDATE channel_host_credentials
         SET revoked_at = ?
         WHERE credential_id = ?
           AND channel_id = ?
           AND authority = 'linked'
           AND revoked_at IS NULL`,
            )
            .bind(Date.now(), normalizedCredentialId, owner.channel_id)
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            const existing = await database
                .prepare(
                    `SELECT credential_id
           FROM channel_host_credentials
           WHERE credential_id = ?
             AND channel_id = ?
             AND authority = 'linked'`,
                )
                .bind(normalizedCredentialId, owner.channel_id)
                .first<{ readonly credential_id: string }>();
            signal.throwIfAborted();
            if (existing !== null) {
                return new ChannelHostCredential(
                    owner.channel_id,
                    owner.runtime_id,
                    owner.tenant_id,
                    owner.project_id,
                    existing.credential_id,
                );
            }
            throw new PairingDirectoryError("linked_device_not_found", "The linked device was not found");
        }
        return new ChannelHostCredential(
            owner.channel_id,
            owner.runtime_id,
            owner.tenant_id,
            owner.project_id,
            normalizedCredentialId,
        );
    };

    readonly revokeProjectRuntime = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<RevokedProjectRuntime> => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const tenant = await this.tenants.resolve(owner.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const row = await database
            .prepare(
                `SELECT pairing_id, channel_id, runtime_id, tenant_id, project_id, status, revoked_at
                   FROM pairing_channels
                  WHERE tenant_id = ? AND project_id = ? AND runtime_id = ?`,
            )
            .bind(owner.tenantId, owner.projectId, validateIdentifier(runtimeId, "runtime_id"))
            .first<RevocableRuntimeRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        const now = Date.now();
        let revokedAt = now;
        if (row.status === "revoked") {
            if (typeof row.revoked_at !== "number" || !Number.isSafeInteger(row.revoked_at)) {
                throw new PairingDirectoryError("invalid_directory_record", "The Runtime directory is invalid");
            }
            revokedAt = row.revoked_at;
        }
        const results = await database.batch([
            database
                .prepare(
                    `UPDATE pairing_channels
                        SET status = 'revoked', daemon_token_hash = NULL,
                            revoked_at = COALESCE(revoked_at, ?),
                            revoked_by_owner_credential_id = COALESCE(revoked_by_owner_credential_id, ?)
                      WHERE pairing_id = ? AND tenant_id = ? AND project_id = ? AND runtime_id = ?`,
                )
                .bind(revokedAt, owner.credentialId, row.pairing_id, owner.tenantId, owner.projectId, row.runtime_id),
            database
                .prepare(
                    `UPDATE channel_host_credentials
                        SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE channel_id = ?`,
                )
                .bind(revokedAt, row.channel_id),
            database
                .prepare(
                    `UPDATE channel_access_grants
                        SET expires_at = MIN(expires_at, ?)
                      WHERE channel_id = ?`,
                )
                .bind(revokedAt, row.channel_id),
            database
                .prepare(
                    `UPDATE bot_behavior_revisions
                        SET lifecycle = 'proposed'
                      WHERE lifecycle = 'awaiting_local_approval'
                        AND behavior_revision_id IN (
                          SELECT bindings.behavior_revision_id
                            FROM bot_execution_bindings AS bindings
                            INNER JOIN bots ON bots.bot_id = bindings.bot_id
                           WHERE bots.tenant_id = ? AND bots.project_id = ?
                             AND bindings.runtime_id = ? AND bindings.lifecycle = 'requested'
                        )`,
                )
                .bind(owner.tenantId, owner.projectId, row.runtime_id),
            database
                .prepare(
                    `UPDATE bot_conversations
                        SET lifecycle = 'closed', closed_at = COALESCE(closed_at, ?),
                            failure_code = COALESCE(failure_code, 'runtime_revoked')
                      WHERE lifecycle = 'provisioning'
                        AND conversation_id IN (
                          SELECT outbox.subject_id
                            FROM bot_control_outbox AS outbox
                            INNER JOIN bots ON bots.bot_id = outbox.bot_id
                           WHERE bots.tenant_id = ? AND bots.project_id = ?
                             AND outbox.runtime_id = ?
                             AND outbox.message_kind = 'conversation_provisioning'
                             AND outbox.state = 'pending'
                        )`,
                )
                .bind(revokedAt, owner.tenantId, owner.projectId, row.runtime_id),
            database
                .prepare(
                    `UPDATE bot_execution_bindings
                        SET lifecycle = 'unavailable', unavailable_at = COALESCE(unavailable_at, ?),
                            unavailable_code = COALESCE(unavailable_code, 'runtime_revoked'),
                            unavailable_message = COALESCE(unavailable_message, 'The bound Runtime was revoked')
                      WHERE runtime_id = ? AND lifecycle IN ('requested', 'approved')
                        AND EXISTS (
                          SELECT 1 FROM bots
                           WHERE bots.bot_id = bot_execution_bindings.bot_id
                             AND bots.tenant_id = ? AND bots.project_id = ?
                        )`,
                )
                .bind(revokedAt, row.runtime_id, owner.tenantId, owner.projectId),
            database
                .prepare(
                    `UPDATE bot_control_outbox
                        SET state = 'failed', completed_at = COALESCE(completed_at, ?),
                            failure_code = COALESCE(failure_code, 'runtime_revoked')
                      WHERE runtime_id = ? AND state = 'pending'
                        AND EXISTS (
                          SELECT 1 FROM bots
                           WHERE bots.bot_id = bot_control_outbox.bot_id
                             AND bots.tenant_id = ? AND bots.project_id = ?
                        )`,
                )
                .bind(revokedAt, row.runtime_id, owner.tenantId, owner.projectId),
            this.audit(
                database,
                owner.tenantId,
                owner.projectId,
                row.pairing_id,
                row.runtime_id,
                "owner",
                owner.credentialId,
                "runtime_pairing.revoked",
                {},
                revokedAt,
            ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        return new RevokedProjectRuntime(
            new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id),
            new Date(revokedAt).toISOString(),
        );
    };

    readonly revokeBrowserCredential = async (
        projectId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const tenant = await this.tenants.resolve(owner.tenantId, signal);
        const database = this.databases.resolve(tenant.tenantSharding);
        const result = await database
            .prepare(
                `UPDATE project_browser_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE credential_id = ? AND tenant_id = ? AND project_id = ?`,
            )
            .bind(Date.now(), normalizedCredentialId, owner.tenantId, owner.projectId)
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new PairingDirectoryError("browser_credential_not_found", "The browser credential was not found");
        }
    };

    readonly updateAgentCatalog = async (
        channelId: string,
        token: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const database = await this.identityDatabase(
            { kind: "daemon", channelId, tokenHash: await hashSecret(validateToken(token)) },
            signal,
        );
        const result = await database
            .prepare(
                `UPDATE pairing_channels
         SET agents_json = ?, installable_agents_json = ?
         WHERE channel_id = ?
           AND daemon_token_hash = ?
           AND status = 'paired'`,
            )
            .bind(
                JSON.stringify(agents),
                JSON.stringify(installableAgents),
                channelId,
                await hashSecret(validateToken(token)),
            )
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
    };
}
