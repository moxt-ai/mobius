import type { ChannelDescriptor } from "../../entity/pairing/pairing.ts";

export class RuntimeStatus {
    readonly nativeForkRecovery: boolean;
    readonly online: boolean;

    constructor(online: boolean, nativeForkRecovery = false) {
        this.nativeForkRecovery = nativeForkRecovery;
        this.online = online;
    }
}

export class RuntimeDescriptor {
    readonly nativeForkRecovery: boolean;
    readonly agents: ChannelDescriptor["agents"];
    readonly channelId: string;
    readonly machineName: string;
    readonly online: boolean;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(channel: ChannelDescriptor, status: RuntimeStatus) {
        this.nativeForkRecovery = status.nativeForkRecovery;
        this.agents = channel.agents;
        this.channelId = channel.channelId;
        this.machineName = channel.machineName;
        this.online = status.online;
        this.projectId = channel.projectId;
        this.runtimeId = channel.runtimeId;
        this.workspaceName = channel.workspaceName;
    }
}
