import type { PairingIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type {
    AuthorizedChannelRow,
    ChannelCredentialIdentity,
    CredentialMatch,
    LinkedDeviceRow,
    PairingChannelRow,
    PairingClaimRow,
    PairingScopeRow,
    RuntimeChannelRow,
    RuntimeDirectoryRow,
    RuntimePairingRow,
} from "../entity/pairing/pairing-records.ts";
import type { ProjectStoragePlacement } from "./project-storage-directory.ts";

export interface CreateAccessGrant {
    readonly grantId: string;
    readonly channelId: string;
    readonly secretHash: string;
    readonly ownerCredentialId: string;
    readonly now: number;
    readonly expiresAt: number;
}

export interface RedeemAccessGrant {
    readonly channelId: string;
    readonly grantId: string;
    readonly secretHash: string;
    readonly credentialId: string;
    readonly tokenHash: string;
    readonly now: number;
}

/** The outcome of redeeming an access grant; anything but `redeemed` issued no credential. */
export type AccessGrantRedemption =
    | { readonly kind: "redeemed"; readonly projectId: string }
    | { readonly kind: "invalid" }
    | { readonly kind: "already_redeemed" }
    | { readonly kind: "runtime_revoked" }
    | { readonly kind: "expired" }
    | { readonly kind: "not_redeemed" }
    | { readonly kind: "channel_missing" };

export interface CreateBrowserCredential {
    readonly credentialId: string;
    readonly tokenHash: string;
    readonly ownerCredentialId: string;
    readonly now: number;
    readonly expiresAt: number;
}

export interface RequestRuntimePairing {
    readonly pairingId: string;
    readonly codeHash: string;
    readonly pollHash: string;
    readonly channelId: string;
    readonly runtimeId: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
    readonly rejectionAuditId: string;
}

/** The pairing request stored under the idempotency key, or the quota that refused a new one. */
export type RuntimePairingRequest =
    | { readonly kind: "created" }
    | { readonly kind: "existing"; readonly request: RuntimePairingRow }
    | { readonly kind: "quota_exceeded" };

export interface ClaimPairing {
    readonly pairingId: string;
    readonly codeHash: string;
    readonly daemonHash: string;
    readonly now: number;
    readonly machineName: string;
    readonly workspaceName: string;
    readonly agents: string;
    readonly auditId: string;
    readonly rejectionAuditId: string;
}

export interface RevokeRuntime {
    readonly runtimeId: string;
    readonly ownerId: string;
    readonly now: number;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
}

/**
 * The operations on one Project's storage. The Project's storage owner executes each operation as one unit, so the
 * preconditions it checks and the writes it makes are evaluated together; no caller composes queries against Project
 * tables. A null or false result means the precondition did not hold and nothing was written.
 */
export interface ProjectStore {
    /** Authenticates a host credential of a channel and records its use. */
    readonly authenticateHost: (
        channelId: string,
        tokenHash: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<AuthorizedChannelRow | null>;
    readonly isHostCredentialActive: (identity: ChannelCredentialIdentity, signal: AbortSignal) => Promise<boolean>;
    readonly listLinkedDevices: (channelId: string, signal: AbortSignal) => Promise<readonly LinkedDeviceRow[]>;
    /** Revokes a linked device; false when the channel has no such device. Repeating it succeeds. */
    readonly revokeLinkedDevice: (
        channelId: string,
        credentialId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly createAccessGrant: (value: CreateAccessGrant, signal: AbortSignal) => Promise<boolean>;
    readonly redeemAccessGrant: (value: RedeemAccessGrant, signal: AbortSignal) => Promise<AccessGrantRedemption>;
    readonly createBrowserCredential: (value: CreateBrowserCredential, signal: AbortSignal) => Promise<boolean>;
    /** Revokes a browser credential; false when the Project has no such credential. Repeating it succeeds. */
    readonly revokeBrowserCredential: (credentialId: string, now: number, signal: AbortSignal) => Promise<boolean>;
    readonly readDaemon: (channelId: string, tokenHash: string, signal: AbortSignal) => Promise<PairingScopeRow | null>;
    readonly updateAgentCatalog: (
        channelId: string,
        tokenHash: string,
        agents: string,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly isRuntimeActive: (runtimeId: string, signal: AbortSignal) => Promise<boolean>;
    readonly readRuntime: (runtimeId: string, signal: AbortSignal) => Promise<RuntimeDirectoryRow | null>;
    readonly listRuntimes: (signal: AbortSignal) => Promise<readonly RuntimeChannelRow[]>;
    readonly readChannel: (channelId: string, signal: AbortSignal) => Promise<RuntimeChannelRow | null>;
    /**
     * Returns the pairing request created under the idempotency key, or creates one within the Runtime quota. A
     * refused request is audited.
     */
    readonly requestRuntimePairing: (
        value: RequestRuntimePairing,
        signal: AbortSignal,
    ) => Promise<RuntimePairingRequest>;
    readonly readRuntimePairing: (pairingId: string, signal: AbortSignal) => Promise<PairingChannelRow | null>;
    readonly readPairingCode: (codeHash: string, signal: AbortSignal) => Promise<PairingClaimRow | null>;
    /**
     * Claims a pairing for a daemon. A replay with the credential it committed succeeds while the pairing is
     * unexpired; any other failed claim is audited and returns false.
     */
    readonly claimPairing: (value: ClaimPairing, signal: AbortSignal) => Promise<boolean>;
    /** Revokes a Runtime and returns its committed revocation; null when the Project has no such Runtime. */
    readonly revokeRuntime: (value: RevokeRuntime, signal: AbortSignal) => Promise<RuntimeDirectoryRow | null>;
    /** The Projects whose stored credential matches; the caller decides what a match authorizes. */
    readonly findCredential: (
        credential: PairingIdentityCredential,
        signal: AbortSignal,
    ) => Promise<readonly CredentialMatch[]>;
    readonly findRuntimeCredential: (tokenHash: string, signal: AbortSignal) => Promise<readonly PairingScopeRow[]>;
}

export interface ProjectStoreResolver {
    readonly resolve: (placement: ProjectStoragePlacement) => ProjectStore;
}
