import {
    ACCESS_GRANT_LIFETIME_MILLISECONDS,
    ChannelDescriptor,
    ChannelHostCredential,
    CreatedBrowserCredential,
    CreatedRuntimePairing,
    createRandomPairingCode,
    createRandomToken,
    ExpiredPairingStatus,
    hashSecret,
    LinkedChannelDevice,
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MAX_RUNTIMES_PER_PROJECT,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairedPairingStatus,
    PairingDirectoryError,
    PendingPairingStatus,
    ProjectOwnerAccess,
    ProjectScopeAccess,
    parseAgents,
    parseInstallableAgents,
    RevokedPairingStatus,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
    validateIdentifier,
    validateToken,
} from "../../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { PairingChannelRow, RuntimePairingRow } from "../../entity/pairing/pairing-records.ts";
import type { TenantContext, TenantShardingDirectory } from "../../infra/tenant-sharding-directory.ts";
import type { AuthorizedChannelRow, PairingStorage } from "../../storage/pairing-storage.ts";
import type { PairingIdentityService } from "./pairing-identity-service.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { deriveRuntimePairingSecrets } from "./runtime-pairing-secrets.ts";

export interface PairingDirectoryInfrastructure {
    readonly storages: { readonly forTenant: (tenant: TenantContext) => PairingStorage };
    readonly services: { readonly identities: PairingIdentityService };
    readonly gateways: {
        readonly tenantShardingDirectory: TenantShardingDirectory;
    };
}

export class PairingDirectoryService implements PairingOperations {
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly tenantStorage = async (tenantId: string, signal: AbortSignal) => {
        const tenant = await this.#cx.gateways.tenantShardingDirectory.resolve(tenantId, signal);
        signal.throwIfAborted();
        return this.#cx.storages.forTenant(tenant);
    };

    private readonly identityStorage = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        const tenant = await this.#cx.services.identities.authenticateTenant(credential, signal);
        return this.#cx.storages.forTenant(tenant);
    };

    private readonly readAuthorizedHost = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "host", channelId, tokenHash }, signal);
        const row = await storage.readHost(validateIdentifier(channelId, "channel_id"), tokenHash, signal);
        if (row === null || (await storage.touchHost(row.credential_id, Date.now(), signal)).meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        return row;
    };

    private readonly readAuthorizedOwner = async (channelId: string, token: string, signal: AbortSignal) => {
        const row = await this.readAuthorizedHost(channelId, token, signal);
        if (row.authority !== "owner") {
            throw new PairingDirectoryError(
                "owner_access_required",
                "Only the channel owner can manage linked devices",
            );
        }
        return row;
    };

    private readonly readAuthorizedProjectOwner = async (projectId: string, token: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "project", projectId, tokenHash }, signal);
        const row = await storage.readProjectOwner(validateIdentifier(projectId, "project_id"), tokenHash, signal);
        if (row === null || (await storage.touchOwner(row.credential_id, Date.now(), signal)).meta.changes !== 1) {
            throw new PairingDirectoryError("owner_access_required", "An owner app credential is required");
        }
        return new ProjectOwnerAccess(row.tenant_id, row.project_id, row.credential_id);
    };

    private readonly authorizeBrowserProject = async (
        storage: PairingStorage,
        projectId: string,
        tokenHash: string,
        signal: AbortSignal,
    ) => {
        const row = await storage.readBrowser(validateIdentifier(projectId, "project_id"), tokenHash, signal);
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
        if ((await storage.touchBrowser(row.credential_id, now, signal)).meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project credential is required");
        }
        return new ProjectScopeAccess(row.tenant_id, row.project_id);
    };

    readonly authorizeDaemon: PairingOperations["authorizeDaemon"] = async (channelId, token, signal) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "daemon", channelId, tokenHash }, signal);
        const row = await storage.readDaemon(channelId, tokenHash, signal);
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        if (row.channel_id !== channelId) {
            throw new PairingDirectoryError("invalid_directory_record", "The channel directory is invalid");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    readonly authorizeHost: PairingOperations["authorizeHost"] = async (channelId, token, signal) => {
        const row = await this.readAuthorizedHost(channelId, token, signal);
        return new ChannelHostCredential(
            row.channel_id,
            row.runtime_id,
            row.tenant_id,
            row.project_id,
            row.credential_id,
        );
    };

    readonly authorizeProject: PairingOperations["authorizeProject"] = async (projectId, token, signal) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "project", projectId, tokenHash }, signal);
        const owner = await storage.readProjectOwner(validateIdentifier(projectId, "project_id"), tokenHash, signal);
        if (owner !== null) {
            if ((await storage.touchOwner(owner.credential_id, Date.now(), signal)).meta.changes !== 1) {
                throw new PairingDirectoryError("unauthorized", "A valid project token is required");
            }
            return new ProjectScopeAccess(owner.tenant_id, owner.project_id);
        }
        const row = await storage.readProjectHost(validateIdentifier(projectId, "project_id"), tokenHash, signal);
        if (row === null) {
            return this.authorizeBrowserProject(storage, projectId, tokenHash, signal);
        }
        if ((await storage.touchHost(row.credential_id, Date.now(), signal)).meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project token is required");
        }
        return new ProjectScopeAccess(row.tenant_id, row.project_id);
    };

    readonly authorizeProjectRuntime: PairingOperations["authorizeProjectRuntime"] = async (
        projectId,
        runtimeId,
        token,
        signal,
    ) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "project", projectId, tokenHash }, signal);
        const owner = await storage.readProjectOwner(validateIdentifier(projectId, "project_id"), tokenHash, signal);
        if (owner !== null) {
            if ((await storage.touchOwner(owner.credential_id, Date.now(), signal)).meta.changes !== 1) {
                throw new PairingDirectoryError("unauthorized", "A valid project Runtime credential is required");
            }
            return this.readProjectRuntime(
                storage,
                new ProjectScopeAccess(owner.tenant_id, owner.project_id),
                runtimeId,
                signal,
            );
        }
        const row = await storage.readRuntimeHost(
            validateIdentifier(projectId, "project_id"),
            validateIdentifier(runtimeId, "runtime_id"),
            tokenHash,
            signal,
        );
        if (row === null) {
            const browser = await this.authorizeBrowserProject(storage, projectId, tokenHash, signal);
            return this.readProjectRuntime(storage, browser, runtimeId, signal);
        }
        if ((await storage.touchHost(row.credential_id, Date.now(), signal)).meta.changes !== 1) {
            throw new PairingDirectoryError("unauthorized", "A valid project Runtime credential is required");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id);
    };

    private readonly readProjectRuntime = async (
        storage: PairingStorage,
        access: ProjectScopeAccess,
        runtimeId: string,
        signal: AbortSignal,
    ) => {
        const row = await storage.readRuntime(
            access.tenantId,
            access.projectId,
            validateIdentifier(runtimeId, "runtime_id"),
            signal,
        );
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
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
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
        const secrets = await deriveRuntimePairingSecrets(token, owner.projectId, idempotencyKey);
        const codeHash = await hashSecret(secrets.pairingCode);
        const pollHash = await hashSecret(secrets.pollToken);
        signal.throwIfAborted();
        if (row.pairing_code_hash !== codeHash || row.poll_token_hash !== pollHash) {
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

    readonly createProjectRuntimePairing: PairingOperations["createProjectRuntimePairing"] = async (
        projectId,
        token,
        idempotencyKey,
        signal,
    ) => {
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.readAuthorizedProjectOwner(normalizedProjectId, token, signal);
        const storage = await this.tenantStorage(owner.tenantId, signal);
        const now = Date.now();
        await storage.expireProjectPairings(
            owner.tenantId,
            owner.projectId,
            now,
            `rpa_${crypto.randomUUID()}_`,
            signal,
        );
        const existing = await storage.readRuntimePairingRequest(
            owner.tenantId,
            owner.projectId,
            normalizedKey,
            signal,
        );
        if (existing !== null) {
            return this.decodeCreatedRuntimePairing(existing, owner, token, normalizedKey, signal);
        }
        const secrets = await deriveRuntimePairingSecrets(token, owner.projectId, normalizedKey);
        const pairingId = crypto.randomUUID();
        const channelId = `chn_${createRandomToken(18)}`;
        const runtimeId = `rnt_${createRandomToken(18)}`;
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        try {
            const results = await storage.createRuntimePairing(
                {
                    pairingId,
                    codeHash: await hashSecret(secrets.pairingCode),
                    pollHash: await hashSecret(secrets.pollToken),
                    channelId,
                    runtimeId,
                    tenantId: owner.tenantId,
                    projectId: owner.projectId,
                    now,
                    expiresAt,
                    idempotencyKey: normalizedKey,
                    ownerId: owner.credentialId,
                    maximumRuntimes: MAX_RUNTIMES_PER_PROJECT,
                    auditId: `rpa_${crypto.randomUUID()}`,
                },
                signal,
            );
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
            const duplicate = await storage.readRuntimePairingRequest(
                owner.tenantId,
                owner.projectId,
                normalizedKey,
                signal,
            );
            if (duplicate !== null) {
                return this.decodeCreatedRuntimePairing(duplicate, owner, token, normalizedKey, signal);
            }
            const quota = await storage.countActiveRuntimes(owner.tenantId, owner.projectId, signal);
            if (quota !== null && quota.active_count >= MAX_RUNTIMES_PER_PROJECT) {
                await storage.recordAudit(
                    {
                        auditId: `rpa_${crypto.randomUUID()}`,
                        tenantId: owner.tenantId,
                        projectId: owner.projectId,
                        pairingId,
                        runtimeId,
                        actorKind: "owner",
                        actorId: owner.credentialId,
                        action: "runtime_pairing.rejected",
                        details: { code: "runtime_quota_exceeded" },
                        recordedAt: now,
                    },
                    signal,
                );
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

    readonly readProjectRuntimePairing: PairingOperations["readProjectRuntimePairing"] = async (
        projectId,
        pairingId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const storage = await this.tenantStorage(owner.tenantId, signal);
        const row = await storage.readProjectPairing(
            owner.tenantId,
            owner.projectId,
            validateIdentifier(pairingId, "pairing_id"),
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Runtime pairing request was not found");
        }
        return this.decodePairingStatus(storage, row, signal);
    };

    readonly revokeProjectRuntime: PairingOperations["revokeProjectRuntime"] = async (
        projectId,
        runtimeId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const storage = await this.tenantStorage(owner.tenantId, signal);
        const row = await storage.readRevocableRuntime(
            owner.tenantId,
            owner.projectId,
            validateIdentifier(runtimeId, "runtime_id"),
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        let revokedAt = Date.now();
        if (row.status === "revoked") {
            if (typeof row.revoked_at !== "number" || !Number.isSafeInteger(row.revoked_at)) {
                throw new PairingDirectoryError("invalid_directory_record", "The Runtime directory is invalid");
            }
            revokedAt = row.revoked_at;
        }
        const results = await storage.revokeRuntime(
            {
                pairingId: row.pairing_id,
                channelId: row.channel_id,
                runtimeId: row.runtime_id,
                tenantId: owner.tenantId,
                projectId: owner.projectId,
                ownerId: owner.credentialId,
                revokedAt,
                audit: {
                    auditId: `rpa_${crypto.randomUUID()}`,
                    tenantId: owner.tenantId,
                    projectId: owner.projectId,
                    pairingId: row.pairing_id,
                    runtimeId: row.runtime_id,
                    actorKind: "owner",
                    actorId: owner.credentialId,
                    action: "runtime_pairing.revoked",
                    details: {},
                    recordedAt: revokedAt,
                },
            },
            signal,
        );
        if (results[0]?.meta.changes !== 1) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        return new RevokedProjectRuntime(
            new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.tenant_id, row.project_id),
            new Date(revokedAt).toISOString(),
        );
    };

    readonly claimPairing: PairingOperations["claimPairing"] = async (
        pairingCode,
        machineName,
        workspaceName,
        agents,
        installableAgents,
        signal,
    ) => {
        signal.throwIfAborted();
        const daemonToken = createRandomToken(32);
        const now = Date.now();
        const codeHash = await hashSecret(normalizePairingCode(pairingCode));
        const storage = await this.identityStorage({ kind: "pairing-code", codeHash }, signal);
        const pairing = await storage.readPairingCode(codeHash, signal);
        if (pairing === null) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        if (pairing.status === "pending" && pairing.expires_at > now) {
            const claimed = await storage.claim(
                codeHash,
                await hashSecret(daemonToken),
                now,
                machineName,
                workspaceName,
                JSON.stringify(agents),
                JSON.stringify(installableAgents),
                `rpa_${crypto.randomUUID()}`,
                signal,
            );
            if (claimed[0]?.meta.changes === 1) {
                return { channelId: pairing.channel_id, daemonToken, runtimeId: pairing.runtime_id };
            }
        }
        const current = await storage.readPairingCode(codeHash, signal);
        if (current !== null && current.status === "pending" && current.expires_at <= now) {
            await storage.expirePairing(current.pairing_id, now, `rpa_${crypto.randomUUID()}`, signal);
        }
        await storage.recordAudit(
            {
                auditId: `rpa_${crypto.randomUUID()}`,
                tenantId: pairing.tenant_id,
                projectId: pairing.project_id,
                pairingId: pairing.pairing_id,
                runtimeId: pairing.runtime_id,
                actorKind: "pairing_code",
                actorId: pairing.pairing_id,
                action: "runtime_pairing.rejected",
                details: { code: "invalid_pairing_code" },
                recordedAt: now,
            },
            signal,
        );
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    };

    readonly createChannelAccessGrant: PairingOperations["createChannelAccessGrant"] = async (
        channelId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const now = Date.now();
        const grantId = `grt_${createRandomToken(18)}`;
        const grantSecret = createRandomToken(32);
        const expiresAt = now + ACCESS_GRANT_LIFETIME_MILLISECONDS;
        const storage = await this.tenantStorage(owner.tenant_id, signal);
        const result = await storage.createGrant(
            grantId,
            owner.channel_id,
            await hashSecret(grantSecret),
            owner.credential_id,
            now,
            expiresAt,
            signal,
        );
        if (result.meta.changes !== 1) {
            throw new PairingDirectoryError("directory_unavailable", "The access grant was not stored");
        }
        return { expiresAt: new Date(expiresAt).toISOString(), grantId, grantSecret };
    };

    readonly createBrowserCredential: PairingOperations["createBrowserCredential"] = async (
        projectId,
        token,
        lifetimeMilliseconds,
        signal,
    ) => {
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
        const storage = await this.tenantStorage(owner.tenantId, signal);
        const result = await storage.createBrowser(
            credentialId,
            owner.tenantId,
            owner.projectId,
            await hashSecret(browserToken),
            owner.credentialId,
            now,
            expiresAt,
            signal,
        );
        if (result.meta.changes !== 1) {
            throw new PairingDirectoryError("directory_unavailable", "The browser credential was not stored");
        }
        return new CreatedBrowserCredential(
            credentialId,
            new Date(expiresAt).toISOString(),
            owner.projectId,
            owner.tenantId,
            browserToken,
        );
    };

    readonly createPairing: PairingOperations["createPairing"] = async (tenantId, signal) => {
        signal.throwIfAborted();
        validateIdentifier(tenantId, "tenant_id");
        const storage = await this.tenantStorage(tenantId, signal);
        const now = Date.now();
        const pairingId = crypto.randomUUID();
        const pairingCode = createRandomPairingCode();
        const pollToken = createRandomToken(32);
        const hostToken = createRandomToken(32);
        const ownerId = `hcr_${createRandomToken(18)}`;
        const channelId = `chn_${createRandomToken(18)}`;
        const runtimeId = `rnt_${createRandomToken(18)}`;
        const projectId = `prj_${createRandomToken(18)}`;
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        const results = await storage.createPairing(
            {
                pairingId,
                codeHash: await hashSecret(pairingCode),
                pollHash: await hashSecret(pollToken),
                channelId,
                runtimeId,
                tenantId,
                projectId,
                now,
                expiresAt,
                ownerId,
                hostHash: await hashSecret(hostToken),
                audit: {
                    auditId: `rpa_${crypto.randomUUID()}`,
                    tenantId,
                    projectId,
                    pairingId,
                    runtimeId,
                    actorKind: "bootstrap",
                    actorId: tenantId,
                    action: "runtime_pairing.requested",
                    details: {},
                    recordedAt: now,
                },
            },
            signal,
        );
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new PairingDirectoryError("directory_unavailable", "The pairing credentials were not stored");
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

    readonly listLinkedChannelDevices: PairingOperations["listLinkedChannelDevices"] = async (
        channelId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const storage = await this.tenantStorage(owner.tenant_id, signal);
        const page = await storage.listLinked(owner.channel_id, signal);
        return page.results.map(
            (row) =>
                new LinkedChannelDevice(
                    row.credential_id,
                    new Date(row.created_at).toISOString(),
                    new Date(row.last_used_at).toISOString(),
                ),
        );
    };

    readonly listProjectRuntimes: PairingOperations["listProjectRuntimes"] = async (projectId, token, signal) => {
        const access = await this.authorizeProject(projectId, token, signal);
        const storage = await this.tenantStorage(access.tenantId, signal);
        const page = await storage.listRuntimes(access.tenantId, access.projectId, signal);
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

    readonly readChannel: PairingOperations["readChannel"] = async (channelId, token, signal) => {
        const access = await this.readAuthorizedHost(channelId, token, signal);
        const storage = await this.tenantStorage(access.tenant_id, signal);
        const row = await storage.readChannel(access.channel_id, signal);
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

    readonly readPairingStatus: PairingOperations["readPairingStatus"] = async (pairingId, pollToken, signal) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(pollToken);
        const storage = await this.identityStorage({ kind: "pairing", pairingId, tokenHash }, signal);
        const row = await storage.readPairing(pairingId, tokenHash, signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The pairing request was not found");
        }
        return this.decodePairingStatus(storage, row, signal);
    };

    private readonly decodePairingStatus = async (
        storage: PairingStorage,
        row: PairingChannelRow,
        signal: AbortSignal,
    ) => {
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
                await storage.expirePairing(row.pairing_id, now, `rpa_${crypto.randomUUID()}`, signal);
            }
            return new ExpiredPairingStatus();
        }
        if (row.status !== "pending") {
            throw new PairingDirectoryError("invalid_directory_record", "The pairing status is invalid");
        }
        return new PendingPairingStatus(new Date(row.expires_at).toISOString());
    };

    readonly redeemChannelAccessGrant: PairingOperations["redeemChannelAccessGrant"] = async (
        channelId,
        grantId,
        grantSecret,
        signal,
    ) => {
        signal.throwIfAborted();
        const normalizedChannelId = validateIdentifier(channelId, "channel_id");
        const normalizedGrantId = validateIdentifier(grantId, "grant_id");
        const secretHash = await hashSecret(validateToken(grantSecret));
        const now = Date.now();
        const credentialId = `hcr_${createRandomToken(18)}`;
        const hostToken = createRandomToken(32);
        const storage = await this.identityStorage({ kind: "grant", channelId, grantId, secretHash }, signal);
        const results = await storage.redeemGrant(
            normalizedChannelId,
            normalizedGrantId,
            secretHash,
            credentialId,
            await hashSecret(hostToken),
            now,
            signal,
        );
        if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
            const state = await storage.readGrant(normalizedChannelId, normalizedGrantId, secretHash, signal);
            if (state === null) {
                throw new PairingDirectoryError("access_grant_invalid", "The access link is invalid");
            }
            if (state.is_redeemed === 1) {
                throw new PairingDirectoryError("access_grant_redeemed", "The access link has already been used");
            }
            if (state.expires_at <= now) {
                throw new PairingDirectoryError("access_grant_expired", "The access link has expired");
            }
            throw new PairingDirectoryError("directory_unavailable", "The access grant could not be redeemed");
        }
        const channel = await storage.readChannel(normalizedChannelId, signal);
        if (channel === null) {
            throw new PairingDirectoryError("invalid_directory_record", "The redeemed channel directory is invalid");
        }
        return {
            channelId: normalizedChannelId,
            hostToken,
            projectId: channel.project_id,
            tenantId: channel.tenant_id,
        };
    };

    readonly revokeLinkedChannelDevice: PairingOperations["revokeLinkedChannelDevice"] = async (
        channelId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.tenantStorage(owner.tenant_id, signal);
        const result = await storage.revokeLinked(owner.channel_id, normalizedCredentialId, Date.now(), signal);
        if (
            result.meta.changes !== 1 &&
            (await storage.readLinked(owner.channel_id, normalizedCredentialId, signal)) === null
        ) {
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

    readonly revokeBrowserCredential: PairingOperations["revokeBrowserCredential"] = async (
        projectId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedProjectOwner(projectId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.tenantStorage(owner.tenantId, signal);
        if (
            (await storage.revokeBrowser(owner.tenantId, owner.projectId, normalizedCredentialId, Date.now(), signal))
                .meta.changes !== 1
        ) {
            throw new PairingDirectoryError("browser_credential_not_found", "The browser credential was not found");
        }
    };

    readonly updateAgentCatalog: PairingOperations["updateAgentCatalog"] = async (
        channelId,
        token,
        agents,
        installableAgents,
        signal,
    ) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "daemon", channelId, tokenHash }, signal);
        if (
            (
                await storage.updateAgents(
                    channelId,
                    tokenHash,
                    JSON.stringify(agents),
                    JSON.stringify(installableAgents),
                    signal,
                )
            ).meta.changes !== 1
        ) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
    };
}
