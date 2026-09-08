import type {
    AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    ClaimedPairing,
    CreatedBrowserCredential,
    CreatedChannelAccessGrant,
    CreatedPairing,
    InstallableAgentDescriptor,
    LinkedChannelDevice,
    PairingStatus,
    ProjectScopeAccess,
    RedeemedChannelAccessGrant,
    VerifiedChannelAccess,
} from "../service/pairing/pairing.ts";
export interface PairingGateway {
    readonly authorizeDaemon: (channelId: string, token: string, signal: AbortSignal) => Promise<VerifiedChannelAccess>;
    readonly authorizeHost: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelHostCredential>;
    readonly authorizeProject: (projectId: string, token: string, signal: AbortSignal) => Promise<ProjectScopeAccess>;
    readonly authorizeProjectRuntime: (
        projectId: string,
        runtimeId: string,
        token: string,
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
    readonly createPairing: (signal: AbortSignal) => Promise<CreatedPairing>;
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
    readonly updateAgentCatalog: (
        channelId: string,
        token: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<void>;
}
