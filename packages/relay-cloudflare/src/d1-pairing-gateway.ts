import {
    ACCESS_GRANT_LIFETIME_MILLISECONDS,
    type AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    type ClaimedPairing,
    CreatedBrowserCredential,
    type CreatedChannelAccessGrant,
    type CreatedPairing,
    createRandomPairingCode,
    createRandomToken,
    ExpiredPairingStatus,
    hashSecret,
    type InstallableAgentDescriptor,
    LinkedChannelDevice,
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairedPairingStatus,
    PairingDirectoryError,
    type PairingGateway,
    type PairingStatus,
    PendingPairingStatus,
    ProjectScopeAccess,
    parseAgents,
    parseInstallableAgents,
    type RedeemedChannelAccessGrant,
    VerifiedChannelAccess,
    validateIdentifier,
    validateToken,
} from "@moxt-ai/mobius-relay-core";

interface PairingChannelRow {
    readonly agents_json: string;
    readonly channel_id: string;
    readonly expires_at: number;
    readonly installable_agents_json: string;
    readonly machine_name: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly status: string;
    readonly tenant_id: string;
    readonly workspace_name: string;
}

interface ChannelScopeRow {
    readonly channel_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
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

interface ClaimedChannelRow {
    readonly channel_id: string;
    readonly runtime_id: string;
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

export class D1PairingGateway implements PairingGateway {
    private readonly database: D1Database;

    constructor(cx: { readonly gateways: { readonly directoryDatabase: D1Database } }) {
        this.database = cx.gateways.directoryDatabase;
    }

    private readonly readAuthorizedHost = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const row = await this.database
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
        const touched = await this.database
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
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const row = await this.database
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
           AND credentials.authority = 'owner'
           AND channels.status = 'paired'`,
            )
            .bind(validateIdentifier(projectId, "project_id"), tokenHash)
            .first<AuthorizedChannelRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PairingDirectoryError("owner_access_required", "An owner app credential is required");
        }
        return row;
    };

    private readonly authorizeBrowserProject = async (
        projectId: string,
        tokenHash: string,
        signal: AbortSignal,
    ): Promise<ProjectScopeAccess> => {
        const row = await this.database
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
        const touched = await this.database
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
        const row = await this.database
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
        const row = await this.database
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
            return await this.authorizeBrowserProject(projectId, tokenHash, signal);
        }
        const touched = await this.database
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
        const row = await this.database
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
            const browser = await this.authorizeBrowserProject(projectId, tokenHash, signal);
            const channel = await this.database
                .prepare(
                    `SELECT channel_id, runtime_id, tenant_id, project_id
           FROM pairing_channels
           WHERE tenant_id = ? AND project_id = ? AND runtime_id = ?
             AND status = 'paired'`,
                )
                .bind(browser.tenantId, browser.projectId, validateIdentifier(runtimeId, "runtime_id"))
                .first<ChannelScopeRow>();
            signal.throwIfAborted();
            if (channel === null) {
                throw new PairingDirectoryError("unauthorized", "The project credential cannot access this Runtime");
            }
            return new VerifiedChannelAccess(
                channel.channel_id,
                channel.runtime_id,
                channel.tenant_id,
                channel.project_id,
            );
        }
        const touched = await this.database
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
        const claimed = await this.database
            .prepare(
                `UPDATE pairing_channels
         SET status = 'paired',
             daemon_token_hash = ?,
             claimed_at = ?,
             machine_name = ?,
             workspace_name = ?,
             agents_json = ?,
             installable_agents_json = ?
         WHERE pairing_code_hash = ?
           AND status = 'pending'
           AND expires_at > ?
         RETURNING channel_id, runtime_id`,
            )
            .bind(
                await hashSecret(daemonToken),
                now,
                machineName,
                workspaceName,
                JSON.stringify(agents),
                JSON.stringify(installableAgents),
                await hashSecret(normalizePairingCode(pairingCode)),
                now,
            )
            .first<ClaimedChannelRow>();
        signal.throwIfAborted();

        if (claimed === null) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        return {
            channelId: claimed.channel_id,
            daemonToken,
            runtimeId: claimed.runtime_id,
        };
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
        const result = await this.database
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
        const result = await this.database
            .prepare(
                `INSERT INTO project_browser_credentials (
           credential_id, tenant_id, project_id, token_hash,
           created_by_credential_id, created_at, expires_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                credentialId,
                owner.tenant_id,
                owner.project_id,
                await hashSecret(browserToken),
                owner.credential_id,
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
            owner.project_id,
            owner.tenant_id,
            browserToken,
        );
    };

    readonly createPairing = async (tenantId: string, signal: AbortSignal): Promise<CreatedPairing> => {
        signal.throwIfAborted();
        validateIdentifier(tenantId, "tenant_id");
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

        const results = await this.database.batch([
            this.database
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
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
            this.database
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
        const page = await this.database
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
        const page = await this.database
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
        const row = await this.database
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
        const row = await this.database
            .prepare(
                `SELECT status, channel_id, runtime_id, expires_at, machine_name, workspace_name,
                agents_json, installable_agents_json, tenant_id, project_id
         FROM pairing_channels
         WHERE pairing_id = ? AND poll_token_hash = ?`,
            )
            .bind(pairingId, await hashSecret(pollToken))
            .first<PairingChannelRow>();
        signal.throwIfAborted();

        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The pairing request was not found");
        }
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
        if (row.status !== "pending") {
            throw new PairingDirectoryError("invalid_directory_record", "The pairing status is invalid");
        }
        if (row.expires_at <= Date.now()) {
            return new ExpiredPairingStatus();
        }
        return new PendingPairingStatus(new Date(row.expires_at).toISOString());
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
        const results = await this.database.batch([
            this.database
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
            this.database
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
            const state = await this.database
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

        const channel = await this.database
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
        const result = await this.database
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
            const existing = await this.database
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

    readonly revokeBrowserCredential = async (
        projectId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const result = await this.database
            .prepare(
                `UPDATE project_browser_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE credential_id = ? AND tenant_id = ? AND project_id = ?`,
            )
            .bind(Date.now(), normalizedCredentialId, owner.tenant_id, owner.project_id)
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
        const result = await this.database
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
