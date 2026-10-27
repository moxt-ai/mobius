import type {
    ProjectAccessContext,
    ProjectPermission,
    RuntimeAccessContext,
} from "../../entity/authentication/project-authentication.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type {
    AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    ClaimedPairing,
    CreatedBrowserCredential,
    CreatedChannelAccessGrant,
    CreatedRuntimePairing,
    LinkedChannelDevice,
    PairingStatus,
    RedeemedChannelAccessGrant,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
} from "../../entity/pairing/pairing.ts";
export interface PairingOperations {
    readonly openProjectScopeControlHost: (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => Promise<ChannelHostCredential>;
    readonly openControlHost: (
        projectId: string,
        runtimeId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ChannelHostCredential>;
    readonly closeControlHost: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
    readonly authorizeDaemon: (channelId: string, token: string, signal: AbortSignal) => Promise<RuntimeAccessContext>;
    readonly authorizeRuntimeCredential: (token: string, signal: AbortSignal) => Promise<RuntimeAccessContext>;
    readonly authorizeHost: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelHostCredential>;
    readonly authorizeProjectRuntimeHost: (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<ChannelHostCredential>;
    readonly authorizeProject: (
        projectId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
    readonly authorizeProjectRuntime: (
        projectId: string,
        runtimeId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<VerifiedChannelAccess>;
    readonly authorizeProjectScopeRuntime: (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => Promise<VerifiedChannelAccess>;
    readonly claimPairing: (
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<ClaimedPairing>;
    readonly createChannelAccessGrant: (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<CreatedChannelAccessGrant>;
    readonly createBrowserCredential: (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<CreatedBrowserCredential>;
    // v1: reserve capacity atomically. The same Project/key/credential replays
    // the original identity, secrets, and deadline, including after expiration
    // or revocation. A failed response may follow a commit; retry the same key.
    readonly createProjectRuntimePairing: (
        projectId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => Promise<CreatedRuntimePairing>;
    readonly listLinkedChannelDevices: (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<readonly LinkedChannelDevice[]>;
    readonly listProjectRuntimes: (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<readonly ChannelDescriptor[]>;
    readonly readChannel: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelDescriptor>;
    // Read-only v1 projection: revoked, claimed, expired, or pending, in that
    // order. Passing the deadline never expires an already registered Runtime.
    readonly readProjectRuntimePairing: (
        projectId: string,
        pairingId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<PairingStatus>;
    // v1: one unrevoked, unexpired request can be consumed by one daemon. The
    // registration, credential, and audit commit together. Concurrent/repeated
    // claims fail; a lost successful response cannot replay the daemon secret.
    readonly redeemRuntimePairing: (
        pairingId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<ClaimedPairing>;
    readonly redeemChannelAccessGrant: (
        channelId: string,
        grantId: string,
        grantSecret: string,
        signal: AbortSignal,
    ) => Promise<RedeemedChannelAccessGrant>;
    readonly revokeLinkedChannelDevice: (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<ChannelHostCredential>;
    readonly revokeBrowserCredential: (
        projectId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<void>;
    // Revoke identity and channel credentials atomically, preserving the first
    // revocation timestamp. Retrying after a lost response or disconnect failure
    // is safe; an unclaimed identity can also be cancelled through this command.
    readonly revokeProjectRuntime: (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<RevokedProjectRuntime>;
    readonly updateAgentCatalog: (
        channelId: string,
        token: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<void>;
}
