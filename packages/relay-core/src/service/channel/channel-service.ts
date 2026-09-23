import type { AgentDescriptor, InstallableAgentDescriptor } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/index.ts";
import type { PairingOperations } from "../pairing/pairing-operations.ts";
export class ChannelService {
    readonly #pairings: PairingOperations;
    readonly #channelGateway: ChannelGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
        };
    }) {
        const { channelGateway } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#channelGateway = channelGateway;
    }
    readonly updateAgentCatalog = (
        channelId: string,
        token: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.updateAgentCatalog(channelId, token, agents, installableAgents, signal);

    readonly createAccessGrant = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.createChannelAccessGrant(channelId, token, signal);

    readonly redeemAccessGrant = (channelId: string, grantId: string, grantSecret: string, signal: AbortSignal) =>
        this.#pairings.redeemChannelAccessGrant(channelId, grantId, grantSecret, signal);

    readonly listLinkedDevices = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.listLinkedChannelDevices(channelId, token, signal);

    readonly revokeLinkedDevice = async (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const credential = await this.#pairings.revokeLinkedChannelDevice(channelId, credentialId, token, signal);
        await this.#channelGateway.disconnectHost(credential, signal);
    };

    readonly readChannel = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.readChannel(channelId, token, signal);

    readonly authorizeHost = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.authorizeHost(channelId, token, signal);

    readonly authorizeDaemon = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.authorizeDaemon(channelId, token, signal);

    readonly authorizeRuntime = (token: string, signal: AbortSignal) =>
        this.#pairings.authorizeRuntimeCredential(token, signal);
}
