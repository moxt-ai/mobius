import { ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import type { AgentDescriptor, InstallableAgentDescriptor } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway, SessionArtifactGateway, SessionQueryGateway } from "../../gateway/index.ts";
import type { PairingOperations } from "../pairing/pairing-operations.ts";
export class ChannelService {
    readonly #pairings: PairingOperations;
    readonly #channelGateway: ChannelGateway;
    readonly #sessionQueries: SessionQueryGateway;
    readonly #sessionArtifacts: SessionArtifactGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
            readonly sessionQueries: SessionQueryGateway;
            readonly sessionArtifacts: SessionArtifactGateway;
        };
    }) {
        const { channelGateway, sessionQueries, sessionArtifacts } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#channelGateway = channelGateway;
        this.#sessionQueries = sessionQueries;
        this.#sessionArtifacts = sessionArtifacts;
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

    readonly acceptHost = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#pairings.authorizeHost(channelId, token, signal);
        return await this.#channelGateway.acceptHost(access, request, signal);
    };

    readonly acceptDaemon = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#pairings.authorizeDaemon(channelId, token, signal);
        return await this.#channelGateway.acceptDaemon(access, request, signal);
    };

    readonly acceptRuntime = async (token: string, request: Request, signal: AbortSignal): Promise<Response> => {
        const access = await this.#pairings.authorizeRuntimeCredential(token, signal);
        return await this.#channelGateway.acceptDaemon(access, request, signal);
    };

    readonly readArtifactContent = async (
        channelId: string,
        token: string,
        sessionId: string,
        commandId: string,
        artifactId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeDaemon(channelId, token, signal);
        const scope = new ProjectScope(access.projectId);
        const runtimeId = await this.#sessionQueries.readCommandRuntime(scope, sessionId, commandId, signal);
        if (runtimeId !== access.runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The Turn is bound to another Runtime");
        }
        return await this.#sessionArtifacts.readArtifactContent(scope, sessionId, artifactId, signal);
    };
}
