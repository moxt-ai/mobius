import type {
    ProjectAccessContext,
    ProjectPermission,
    RuntimeAccessContext,
} from "../../entity/authentication/project-authentication.ts";
import type {
    AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    ClaimedPairing,
    CreatedBrowserCredential,
    CreatedChannelAccessGrant,
    CreatedPairing,
    CreatedRuntimePairing,
    InstallableAgentDescriptor,
    LinkedChannelDevice,
    PairingStatus,
    RedeemedChannelAccessGrant,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
} from "../../entity/pairing/pairing.ts";
export interface PairingOperations {
    readonly authorizeDaemon: (channelId: string, token: string, signal: AbortSignal) => Promise<RuntimeAccessContext>;
    readonly authorizeHost: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelHostCredential>;
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
    readonly claimPairing: (
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
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
    readonly createPairing: (tenantId: string, signal: AbortSignal) => Promise<CreatedPairing>;
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
    readonly readPairingStatus: (pairingId: string, pollToken: string, signal: AbortSignal) => Promise<PairingStatus>;
    readonly readProjectRuntimePairing: (
        projectId: string,
        pairingId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<PairingStatus>;
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
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<void>;
}
