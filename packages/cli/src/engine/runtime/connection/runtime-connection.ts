export interface RuntimeConnectionInput {
    readonly appId: string;
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export type RuntimeConnectionActivation = "active" | "stopped";

/** A saved pairing: the identity a Runtime presents to the relay, and whether it should run. */
export class VerifiedRuntimeConnection {
    readonly kind = "verified";
    readonly activation: RuntimeConnectionActivation;
    readonly appId: string;
    readonly channelId: string;
    readonly connectionId: string;
    readonly defaultWorkspace: string;
    readonly installationId: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;

    readonly runtimeId: string;

    constructor(
        activation: RuntimeConnectionActivation,
        appId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        pairingId: string,
        relayOrigin: URL,
        runtimeCredential: string,
        runtimeId: string,
    ) {
        this.activation = activation;
        this.appId = appId;
        this.channelId = channelId;
        this.connectionId = connectionId;
        this.defaultWorkspace = defaultWorkspace;
        this.installationId = installationId;
        this.pairingId = pairingId;
        this.relayOrigin = relayOrigin;
        this.runtimeCredential = runtimeCredential;
        this.runtimeId = runtimeId;
    }
}
