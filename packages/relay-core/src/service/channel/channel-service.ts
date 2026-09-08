import type {
    ChannelGateway,
    PairingGateway,
    SessionArtifactGateway,
    SessionQueryGateway,
} from "../../gateway/index.ts";
import type { AgentDescriptor, InstallableAgentDescriptor } from "../pairing/pairing.ts";
import { ProjectScope, SessionRuntimeError } from "../session/session.ts";
export class ChannelService {
    static readonly inject = [
        "pairingGateway",
        "channelGateway",
        "sessionQueries",
        "sessionArtifacts",
    ] satisfies readonly ["pairingGateway", "channelGateway", "sessionQueries", "sessionArtifacts"];
    readonly #pairingGateway: PairingGateway;
    readonly #channelGateway: ChannelGateway;
    readonly #sessionQueries: SessionQueryGateway;
    readonly #sessionArtifacts: SessionArtifactGateway;
    constructor(
        pairingGateway: PairingGateway,
        channelGateway: ChannelGateway,
        sessionQueries: SessionQueryGateway,
        sessionArtifacts: SessionArtifactGateway,
    ) {
        this.#pairingGateway = pairingGateway;
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
    ) => this.#pairingGateway.updateAgentCatalog(channelId, token, agents, installableAgents, signal);

    readonly createAccessGrant = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairingGateway.createChannelAccessGrant(channelId, token, signal);

    readonly redeemAccessGrant = (channelId: string, grantId: string, grantSecret: string, signal: AbortSignal) =>
        this.#pairingGateway.redeemChannelAccessGrant(channelId, grantId, grantSecret, signal);

    readonly listLinkedDevices = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairingGateway.listLinkedChannelDevices(channelId, token, signal);

    readonly revokeLinkedDevice = async (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const credential = await this.#pairingGateway.revokeLinkedChannelDevice(channelId, credentialId, token, signal);
        await this.#channelGateway.disconnectHost(credential, signal);
    };

    readonly readChannel = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairingGateway.readChannel(channelId, token, signal);

    readonly acceptHost = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#pairingGateway.authorizeHost(channelId, token, signal);
        return await this.#channelGateway.acceptHost(access, request, signal);
    };

    readonly acceptDaemon = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#pairingGateway.authorizeDaemon(channelId, token, signal);
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
        const access = await this.#pairingGateway.authorizeDaemon(channelId, token, signal);
        const scope = new ProjectScope(access.tenantId, access.projectId);
        const runtimeId = await this.#sessionQueries.readCommandRuntime(scope, sessionId, commandId, signal);
        if (runtimeId !== access.runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The Turn is bound to another Runtime");
        }
        return await this.#sessionArtifacts.readArtifactContent(scope, sessionId, artifactId, signal);
    };
}
