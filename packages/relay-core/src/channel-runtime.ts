import type { ChannelDescriptor, ChannelHostCredential, VerifiedChannelAccess } from "./pairing-directory.ts";

export interface ChannelRuntime {
    readonly acceptDaemon: (access: VerifiedChannelAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly acceptHost: (access: ChannelHostCredential, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectHost: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
    readonly dispatchPending: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<RuntimeStatus>;
}

export class RuntimeStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class RuntimeDescriptor {
    readonly agents: ChannelDescriptor["agents"];
    readonly channelId: string;
    readonly installableAgents: ChannelDescriptor["installableAgents"];
    readonly machineName: string;
    readonly online: boolean;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;
    readonly workspaceName: string;

    constructor(channel: ChannelDescriptor, status: RuntimeStatus) {
        this.agents = channel.agents;
        this.channelId = channel.channelId;
        this.installableAgents = channel.installableAgents;
        this.machineName = channel.machineName;
        this.online = status.online;
        this.projectId = channel.projectId;
        this.runtimeId = channel.runtimeId;
        this.tenantId = channel.tenantId;
        this.workspaceName = channel.workspaceName;
    }
}
