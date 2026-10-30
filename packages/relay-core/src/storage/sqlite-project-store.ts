import type { ProjectStore } from "../infra/project-store.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { ChannelCredentialStorage } from "./channel-credential-storage.ts";
import { credentialMatches, runtimeCredentialMatches } from "./pairing-identity-storage.ts";
import { PairingStorage } from "./pairing-storage.ts";
import { RuntimeDirectoryStorage } from "./runtime-directory-storage.ts";

/**
 * A Project's operations over its own SQLite storage. Only the Project's storage owner constructs this; each
 * operation runs there as one unit, so its reads, writes and audit events cannot interleave with another operation.
 */
export class SqliteProjectStore implements ProjectStore {
    readonly #projectId: string;
    readonly #database: SqlDatabase;
    readonly #pairings: PairingStorage;
    readonly #runtimes: RuntimeDirectoryStorage;
    readonly #credentials: ChannelCredentialStorage;

    constructor(projectId: string, database: SqlDatabase) {
        this.#projectId = projectId;
        this.#database = database;
        this.#pairings = new PairingStorage(database);
        this.#runtimes = new RuntimeDirectoryStorage(projectId, database);
        this.#credentials = new ChannelCredentialStorage(database);
    }

    readonly authenticateHost: ProjectStore["authenticateHost"] = async (channelId, tokenHash, now, signal) => {
        const row = await this.#pairings.readHost(channelId, tokenHash, signal);
        return row !== null && (await this.#pairings.touchHost(row.credential_id, now, signal)) ? row : null;
    };

    readonly isHostCredentialActive: ProjectStore["isHostCredentialActive"] = async (identity, signal) =>
        identity.projectId === this.#projectId && (await this.#credentials.readActive(identity, signal));

    readonly openControlHost: ProjectStore["openControlHost"] = async (value, signal) => {
        const created = await this.#pairings.createProjectControlHost(
            this.#projectId,
            value.runtimeId,
            value.credentialId,
            value.tokenHash,
            value.now,
            signal,
        );
        return created?.channel_id ?? null;
    };

    readonly closeControlHost: ProjectStore["closeControlHost"] = async (channelId, credentialId, signal) => {
        await this.#pairings.removeControlHost(channelId, credentialId, signal);
    };

    readonly discardControlHost: ProjectStore["discardControlHost"] = async (credentialId, signal) => {
        await this.#pairings.removeProjectControlHost(this.#projectId, credentialId, signal);
    };

    readonly listLinkedDevices: ProjectStore["listLinkedDevices"] = async (channelId, signal) =>
        await this.#pairings.listLinked(channelId, signal);

    readonly revokeLinkedDevice: ProjectStore["revokeLinkedDevice"] = async (channelId, credentialId, now, signal) =>
        (await this.#pairings.revokeLinked(channelId, credentialId, now, signal)).meta.changes === 1 ||
        (await this.#pairings.readLinked(channelId, credentialId, signal)) !== null;

    readonly createAccessGrant: ProjectStore["createAccessGrant"] = async (value, signal) =>
        (
            await this.#pairings.createGrant(
                value.grantId,
                value.channelId,
                value.secretHash,
                value.ownerCredentialId,
                value.now,
                value.expiresAt,
                signal,
            )
        ).meta.changes === 1;

    readonly redeemAccessGrant: ProjectStore["redeemAccessGrant"] = async (value, signal) => {
        const results = await this.#pairings.redeemGrant(
            value.channelId,
            value.grantId,
            value.secretHash,
            value.credentialId,
            value.tokenHash,
            value.now,
            signal,
        );
        if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
            const state = await this.#pairings.readGrant(value.channelId, value.grantId, value.secretHash, signal);
            if (state === null) {
                return { kind: "invalid" };
            }
            if (state.redeemed_at !== null) {
                return { kind: "already_redeemed" };
            }
            if (state.runtime_revoked_at !== null) {
                return { kind: "runtime_revoked" };
            }
            if (state.expires_at <= value.now) {
                return { kind: "expired" };
            }
            return { kind: "not_redeemed" };
        }
        const channel = await this.#runtimes.readChannel(value.channelId, signal);
        return channel === null ? { kind: "channel_missing" } : { kind: "redeemed", projectId: channel.project_id };
    };

    readonly createBrowserCredential: ProjectStore["createBrowserCredential"] = async (value, signal) =>
        (
            await this.#pairings.createBrowser(
                value.credentialId,
                this.#projectId,
                value.tokenHash,
                value.ownerCredentialId,
                value.now,
                value.expiresAt,
                signal,
            )
        ).meta.changes === 1;

    readonly revokeBrowserCredential: ProjectStore["revokeBrowserCredential"] = async (credentialId, now, signal) =>
        (await this.#pairings.revokeBrowser(this.#projectId, credentialId, now, signal)).meta.changes === 1;

    readonly readDaemon: ProjectStore["readDaemon"] = async (channelId, tokenHash, signal) =>
        await this.#runtimes.readDaemon(channelId, tokenHash, signal);

    readonly updateAgentCatalog: ProjectStore["updateAgentCatalog"] = async (channelId, tokenHash, agents, signal) =>
        (await this.#runtimes.updateAgents(channelId, tokenHash, agents, signal)).meta.changes === 1;

    readonly isRuntimeActive: ProjectStore["isRuntimeActive"] = async (runtimeId, signal) =>
        await this.#credentials.readActiveRuntime({ projectId: this.#projectId, runtimeId }, signal);

    readonly readRuntime: ProjectStore["readRuntime"] = async (runtimeId, signal) =>
        await this.#runtimes.readRuntime(runtimeId, signal);

    readonly listRuntimes: ProjectStore["listRuntimes"] = async (signal) => await this.#runtimes.listRuntimes(signal);

    readonly readChannel: ProjectStore["readChannel"] = async (channelId, signal) =>
        await this.#runtimes.readChannel(channelId, signal);

    readonly requestRuntimePairing: ProjectStore["requestRuntimePairing"] = async (value, signal) => {
        const existing = await this.#runtimes.readRuntimePairingRequest(value.idempotencyKey, signal);
        if (existing !== null) {
            return { kind: "existing", request: existing };
        }
        if (await this.#runtimes.createRuntimePairing(value, signal)) {
            return { kind: "created" };
        }
        await this.#runtimes.recordAudit(
            {
                auditId: value.rejectionAuditId,
                projectId: this.#projectId,
                pairingId: value.pairingId,
                runtimeId: value.runtimeId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: "runtime_pairing.rejected",
                details: { code: "runtime_quota_exceeded" },
                recordedAt: value.now,
            },
            signal,
        );
        return { kind: "quota_exceeded" };
    };

    readonly readRuntimePairing: ProjectStore["readRuntimePairing"] = async (pairingId, signal) =>
        await this.#runtimes.readProjectPairing(pairingId, signal);

    readonly readPairingCode: ProjectStore["readPairingCode"] = async (codeHash, signal) =>
        await this.#runtimes.readPairingCode(codeHash, signal);

    readonly claimPairing: ProjectStore["claimPairing"] = async (value, signal) => {
        if (await this.#runtimes.claim(value, signal)) {
            return true;
        }
        // Replays prove possession of the original code and must match the committed credential. Never rotate an
        // older random credential, extend the pairing deadline, or resurrect a revoked Runtime.
        const pairing = await this.#runtimes.readProjectPairing(value.pairingId, signal);
        if (
            pairing !== null &&
            pairing.expires_at > value.now &&
            (await this.#runtimes.readDaemon(pairing.channel_id, value.daemonHash, signal)) !== null
        ) {
            return true;
        }
        await this.#runtimes.recordAudit(
            {
                auditId: value.rejectionAuditId,
                projectId: this.#projectId,
                pairingId: value.pairingId,
                runtimeId: pairing?.runtime_id ?? "",
                actorKind: "pairing_code",
                actorId: value.pairingId,
                action: "runtime_pairing.rejected",
                details: { code: "invalid_pairing_code" },
                recordedAt: value.now,
            },
            signal,
        );
        return false;
    };

    readonly revokeRuntime: ProjectStore["revokeRuntime"] = async (value, signal) =>
        await this.#runtimes.revokeRuntime(value, signal);

    readonly findCredential: ProjectStore["findCredential"] = async (credential, signal) =>
        await credentialMatches(this.#database, credential, signal);

    readonly findRuntimeCredential: ProjectStore["findRuntimeCredential"] = async (tokenHash, signal) =>
        await runtimeCredentialMatches(this.#database, tokenHash, signal);
}
