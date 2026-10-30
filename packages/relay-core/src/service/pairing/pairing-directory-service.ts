import {
    PROJECT_HOST_PERMISSION,
    type ProjectAccessContext,
    ProjectPermission,
    RuntimeAccessContext,
} from "../../entity/authentication/project-authentication.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import type { AgentDescriptor, ClaimedPairing } from "../../entity/pairing/pairing.ts";
import {
    ACCESS_GRANT_LIFETIME_MILLISECONDS,
    ChannelDescriptor,
    ChannelHostCredential,
    CreatedBrowserCredential,
    CreatedRuntimePairing,
    createRandomToken,
    hashSecret,
    LinkedChannelDevice,
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MAX_RUNTIMES_PER_PROJECT,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    ProjectCredentialHostAccess,
    parseAgents,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
    validateIdentifier,
    validateToken,
} from "../../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { AuthorizedChannelRow, RuntimePairingRow } from "../../entity/pairing/pairing-records.ts";
import { projectRuntimePairingStatus, runtimeRevokedAt } from "../../entity/pairing/runtime-pairing-state.ts";
import type { ProjectAccessAuthorizer } from "../../gateway/project-access-authorizer.ts";
import type { ProjectApplicationResolver } from "../../infra/project-application-resolver.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type { ProjectStore } from "../../infra/project-store.ts";
import type { PairingIdentityService } from "./pairing-identity-service.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { deriveRuntimeDaemonToken, deriveRuntimePairingSecrets } from "./runtime-pairing-secrets.ts";

export interface PairingDirectoryInfrastructure {
    readonly gateways: { readonly projectApplications: ProjectApplicationResolver };
    readonly storages: {
        readonly forProject: (project: ProjectStorageContext) => ProjectStore;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly services: {
        readonly identities: PairingIdentityService;
        readonly projectAuthentication: ProjectAccessAuthorizer;
    };
}

export class PairingDirectoryService implements PairingOperations {
    readonly openControlHost: PairingOperations["openControlHost"] = async (
        projectId,
        runtimeId,
        token,
        permission,
        signal,
    ) => {
        const access = await this.authorizeProject(projectId, token, permission, signal);
        const storage = await this.projectStorage(access.scope, signal);
        return await this.openControlHostForScope(storage, access.scope, runtimeId, signal);
    };

    readonly openProjectScopeControlHost = async (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<ChannelHostCredential> => {
        const storage = await this.projectStorage(scope, signal);
        return await this.openControlHostForScope(storage, scope, runtimeId, signal);
    };

    private readonly openControlHostForScope = async (
        storage: ProjectStore,
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<ChannelHostCredential> => {
        const normalizedRuntimeId = validateIdentifier(runtimeId, "runtime_id");
        const credentialId = `ctl_${createRandomToken(18)}`;
        let channelId: string | null;
        try {
            channelId = await storage.openControlHost(
                {
                    runtimeId: normalizedRuntimeId,
                    credentialId,
                    tokenHash: await hashSecret(createRandomToken(32)),
                    now: Date.now(),
                },
                signal,
            );
        } catch (cause) {
            await storage.discardControlHost(credentialId, AbortSignal.timeout(15_000));
            throw cause;
        }
        if (channelId === null) {
            await this.readProjectRuntime(storage, normalizedRuntimeId, signal);
            throw new PairingDirectoryError("runtime_unavailable", "The selected Runtime is unavailable");
        }
        return new ChannelHostCredential(channelId, normalizedRuntimeId, scope.projectId, credentialId);
    };

    readonly closeControlHost: PairingOperations["closeControlHost"] = async (access, signal) => {
        const storage = await this.projectStorage(new ProjectScope(access.projectId), signal);
        await storage.closeControlHost(access.channelId, access.credentialId, signal);
    };
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly projectStorage = async (scope: ProjectScope, signal: AbortSignal) => {
        const project = await this.#cx.storages.projectDirectory.resolve(scope.projectId, signal);
        signal.throwIfAborted();
        if (project === null) {
            throw new PairingDirectoryError("unauthorized", "The Project is no longer active");
        }
        if (project.projectId !== scope.projectId) {
            throw new PairingDirectoryError("invalid_directory_record", "The Project storage locator is invalid");
        }
        return this.#cx.storages.forProject(project);
    };

    private readonly identityStorage = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        const project = await this.#cx.services.identities.authenticateProject(credential, signal);
        return this.#cx.storages.forProject(project);
    };

    private readonly readAuthorizedHost = async (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "host", channelId, tokenHash }, signal);
        const row = await storage.authenticateHost(
            validateIdentifier(channelId, "channel_id"),
            tokenHash,
            Date.now(),
            signal,
        );
        if (row === null) {
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
        return new RuntimeAccessContext(
            new ProjectScope(row.project_id),
            row.runtime_id,
            row.channel_id,
            `daemon:${row.channel_id}`,
        );
    };

    readonly authorizeRuntimeCredential: PairingOperations["authorizeRuntimeCredential"] = async (token, signal) => {
        signal.throwIfAborted();
        return await this.#cx.services.identities.authenticateRuntime(await hashSecret(validateToken(token)), signal);
    };

    readonly authorizeHost: PairingOperations["authorizeHost"] = async (channelId, token, signal) => {
        const row = await this.readAuthorizedHost(channelId, token, signal);
        return new ChannelHostCredential(row.channel_id, row.runtime_id, row.project_id, row.credential_id);
    };

    readonly authorizeProject: PairingOperations["authorizeProject"] = async (projectId, token, permission, signal) =>
        await this.#cx.services.projectAuthentication.authorizeProject(projectId, token, permission, "", signal);

    readonly authorizeProjectRuntimeHost: PairingOperations["authorizeProjectRuntimeHost"] = async (
        projectId,
        runtimeId,
        token,
        signal,
    ) => {
        const access = await this.authorizeProject(projectId, token, PROJECT_HOST_PERMISSION, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtime = await this.readProjectRuntime(storage, runtimeId, signal);
        return new ProjectCredentialHostAccess(
            runtime.channelId,
            runtime.runtimeId,
            runtime.projectId,
            access.credentialId,
        );
    };

    readonly authorizeProjectRuntime: PairingOperations["authorizeProjectRuntime"] = async (
        projectId,
        runtimeId,
        token,
        permission,
        signal,
    ) => {
        const access = await this.authorizeProject(projectId, token, permission, signal);
        const storage = await this.projectStorage(access.scope, signal);
        return await this.readProjectRuntime(storage, runtimeId, signal);
    };

    readonly authorizeProjectScopeRuntime: PairingOperations["authorizeProjectScopeRuntime"] = async (
        scope,
        runtimeId,
        signal,
    ) => {
        const storage = await this.projectStorage(scope, signal);
        return await this.readProjectRuntime(storage, runtimeId, signal);
    };

    private readonly readProjectRuntime = async (storage: ProjectStore, runtimeId: string, signal: AbortSignal) => {
        const row = await storage.readRuntime(validateIdentifier(runtimeId, "runtime_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        if (runtimeRevokedAt(row.revoked_at) !== null || row.registration === null) {
            throw new PairingDirectoryError("runtime_unavailable", "The selected Runtime is unavailable");
        }
        return new VerifiedChannelAccess(
            row.channel_id,
            row.runtime_id,
            row.project_id,
            parseAgents(row.registration.agents_json),
        );
    };

    private readonly decodeCreatedRuntimePairing = async (
        row: RuntimePairingRow,
        owner: ProjectAccessContext,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
        if (row.project_id !== owner.projectId || row.created_by_owner_credential_id !== owner.credentialId) {
            throw new PairingDirectoryError(
                "idempotency_conflict",
                "The Runtime pairing idempotency key belongs to another authorized request",
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
        const owner = await this.authorizeProject(normalizedProjectId, token, ProjectPermission.RuntimePair, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveRuntimePairingSecrets(token, owner.projectId, normalizedKey);
        const pairingId = `${owner.projectId}.${crypto.randomUUID()}`;
        const channelId = `chn_${createRandomToken(18)}`;
        const runtimeId = `rnt_${createRandomToken(18)}`;
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ProjectStore["requestRuntimePairing"]>>;
        try {
            stored = await storage.requestRuntimePairing(
                {
                    pairingId,
                    codeHash: await hashSecret(secrets.pairingCode),
                    pollHash: await hashSecret(secrets.pollToken),
                    channelId,
                    runtimeId,
                    now,
                    expiresAt,
                    idempotencyKey: normalizedKey,
                    ownerId: owner.credentialId,
                    actorKind: owner.actor.kind.value,
                    actorId: owner.actor.actorId,
                    auditId: `rpa_${crypto.randomUUID()}`,
                    rejectionAuditId: `rpa_${crypto.randomUUID()}`,
                },
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError("directory_unavailable", "The Runtime pairing could not be stored", {
                cause,
            });
        }
        switch (stored.kind) {
            case "existing":
                return this.decodeCreatedRuntimePairing(stored.request, owner, token, normalizedKey, signal);
            case "quota_exceeded":
                throw new PairingDirectoryError(
                    "runtime_quota_exceeded",
                    `A Project can have at most ${MAX_RUNTIMES_PER_PROJECT.toString()} active Runtimes`,
                );
            case "created":
                return new CreatedRuntimePairing(
                    channelId,
                    new Date(expiresAt).toISOString(),
                    secrets.pairingCode,
                    pairingId,
                    secrets.pollToken,
                    owner.projectId,
                    runtimeId,
                );
        }
    };

    readonly readProjectRuntimePairing: PairingOperations["readProjectRuntimePairing"] = async (
        projectId,
        pairingId,
        token,
        signal,
    ) => {
        const owner = await this.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.readRuntimePairing(validateIdentifier(pairingId, "pairing_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Runtime pairing request was not found");
        }
        return projectRuntimePairingStatus(row, Date.now());
    };

    readonly revokeProjectRuntime: PairingOperations["revokeProjectRuntime"] = async (
        projectId,
        runtimeId,
        token,
        signal,
    ) => {
        const owner = await this.authorizeProject(projectId, token, ProjectPermission.RuntimeRevoke, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.revokeRuntime(
            {
                runtimeId: validateIdentifier(runtimeId, "runtime_id"),
                ownerId: owner.credentialId,
                now: Date.now(),
                actorKind: owner.actor.kind.value,
                actorId: owner.actor.actorId,
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        const revokedAt = runtimeRevokedAt(row.revoked_at);
        if (revokedAt === null) {
            throw new PairingDirectoryError("invalid_directory_record", "The Runtime revocation is invalid");
        }
        return new RevokedProjectRuntime(
            new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.project_id, []),
            new Date(revokedAt).toISOString(),
        );
    };

    private readonly redeemPairing = async (
        expectedPairingId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> => {
        signal.throwIfAborted();
        const codeHash = await hashSecret(normalizePairingCode(pairingCode));
        const storage = await this.identityStorage({ kind: "pairing-code", codeHash }, signal);
        const pairing = await storage.readPairingCode(codeHash, signal);
        if (pairing === null || (expectedPairingId.length > 0 && pairing.pairing_id !== expectedPairingId)) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        const appId = await this.#cx.gateways.projectApplications.resolveApplicationId(pairing.project_id, signal);
        const daemonToken = await deriveRuntimeDaemonToken(
            pairingCode,
            pairing.project_id,
            pairing.pairing_id,
            pairing.poll_token_hash,
        );
        const claimed = await storage.claimPairing(
            {
                pairingId: pairing.pairing_id,
                codeHash,
                daemonHash: await hashSecret(daemonToken),
                now: Date.now(),
                machineName,
                workspaceName,
                agents: JSON.stringify(agents),
                auditId: `rpa_${crypto.randomUUID()}`,
                rejectionAuditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        if (!claimed) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        return { appId, channelId: pairing.channel_id, daemonToken, runtimeId: pairing.runtime_id };
    };

    readonly claimPairing: PairingOperations["claimPairing"] = async (
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) => await this.redeemPairing("", pairingCode, machineName, workspaceName, agents, signal);

    readonly redeemRuntimePairing: PairingOperations["redeemRuntimePairing"] = async (
        pairingId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) =>
        await this.redeemPairing(
            validateIdentifier(pairingId, "pairing_id"),
            pairingCode,
            machineName,
            workspaceName,
            agents,
            signal,
        );

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
        const storage = await this.projectStorage(new ProjectScope(owner.project_id), signal);
        const created = await storage.createAccessGrant(
            {
                grantId,
                channelId: owner.channel_id,
                secretHash: await hashSecret(grantSecret),
                ownerCredentialId: owner.credential_id,
                now,
                expiresAt,
            },
            signal,
        );
        if (!created) {
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
        const owner = await this.authorizeProject(projectId, token, ProjectPermission.OwnerCredentialsManage, signal);
        const now = Date.now();
        const expiresAt = now + lifetimeMilliseconds;
        const credentialId = `bcr_${createRandomToken(18)}`;
        const browserToken = createRandomToken(32);
        const storage = await this.projectStorage(owner.scope, signal);
        const created = await storage.createBrowserCredential(
            {
                credentialId,
                tokenHash: await hashSecret(browserToken),
                ownerCredentialId: owner.credentialId,
                now,
                expiresAt,
            },
            signal,
        );
        if (!created) {
            throw new PairingDirectoryError("directory_unavailable", "The browser credential was not stored");
        }
        return new CreatedBrowserCredential(
            credentialId,
            new Date(expiresAt).toISOString(),
            owner.projectId,
            browserToken,
        );
    };

    readonly listLinkedChannelDevices: PairingOperations["listLinkedChannelDevices"] = async (
        channelId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const storage = await this.projectStorage(new ProjectScope(owner.project_id), signal);
        const devices = await storage.listLinkedDevices(owner.channel_id, signal);
        return devices.map(
            (row) =>
                new LinkedChannelDevice(
                    row.credential_id,
                    new Date(row.created_at).toISOString(),
                    new Date(row.last_used_at).toISOString(),
                ),
        );
    };

    readonly listProjectRuntimes: PairingOperations["listProjectRuntimes"] = async (projectId, token, signal) => {
        const access = await this.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtimes = await storage.listRuntimes(signal);
        return runtimes.map(
            (row) =>
                new ChannelDescriptor(
                    parseAgents(row.agents_json),
                    row.channel_id,
                    row.machine_name,
                    row.workspace_name,
                    row.project_id,
                    row.runtime_id,
                ),
        );
    };

    readonly readChannel: PairingOperations["readChannel"] = async (channelId, token, signal) => {
        const access = await this.readAuthorizedHost(channelId, token, signal);
        const storage = await this.projectStorage(new ProjectScope(access.project_id), signal);
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
            row.project_id,
            row.runtime_id,
        );
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
        const redemption = await storage.redeemAccessGrant(
            {
                channelId: normalizedChannelId,
                grantId: normalizedGrantId,
                secretHash,
                credentialId,
                tokenHash: await hashSecret(hostToken),
                now,
            },
            signal,
        );
        switch (redemption.kind) {
            case "redeemed":
                return { channelId: normalizedChannelId, hostToken, projectId: redemption.projectId };
            case "invalid":
                throw new PairingDirectoryError("access_grant_invalid", "The access link is invalid");
            case "already_redeemed":
                throw new PairingDirectoryError("access_grant_redeemed", "The access link has already been used");
            case "runtime_revoked":
                throw new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
            case "expired":
                throw new PairingDirectoryError("access_grant_expired", "The access link has expired");
            case "not_redeemed":
                throw new PairingDirectoryError("directory_unavailable", "The access grant could not be redeemed");
            case "channel_missing":
                throw new PairingDirectoryError(
                    "invalid_directory_record",
                    "The redeemed channel directory is invalid",
                );
        }
    };

    readonly revokeLinkedChannelDevice: PairingOperations["revokeLinkedChannelDevice"] = async (
        channelId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(channelId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.projectStorage(new ProjectScope(owner.project_id), signal);
        if (!(await storage.revokeLinkedDevice(owner.channel_id, normalizedCredentialId, Date.now(), signal))) {
            throw new PairingDirectoryError("linked_device_not_found", "The linked device was not found");
        }
        return new ChannelHostCredential(owner.channel_id, owner.runtime_id, owner.project_id, normalizedCredentialId);
    };

    readonly revokeBrowserCredential: PairingOperations["revokeBrowserCredential"] = async (
        projectId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.authorizeProject(projectId, token, ProjectPermission.OwnerCredentialsManage, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.projectStorage(owner.scope, signal);
        if (!(await storage.revokeBrowserCredential(normalizedCredentialId, Date.now(), signal))) {
            throw new PairingDirectoryError("browser_credential_not_found", "The browser credential was not found");
        }
    };

    readonly updateAgentCatalog: PairingOperations["updateAgentCatalog"] = async (channelId, token, agents, signal) => {
        signal.throwIfAborted();
        const tokenHash = await hashSecret(validateToken(token));
        const storage = await this.identityStorage({ kind: "daemon", channelId, tokenHash }, signal);
        if (!(await storage.updateAgentCatalog(channelId, tokenHash, JSON.stringify(agents), signal))) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
    };
}
