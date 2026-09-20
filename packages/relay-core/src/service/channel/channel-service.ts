import {
    type ArtifactUploadAuthorization,
    type ArtifactUploadLease,
    type AvailableArtifactDescriptor,
    type CreateArtifactUploadRequest,
    ProjectScope,
    SessionRuntimeError,
} from "../../entity/do/session.ts";
import {
    type AgentDescriptor,
    type InstallableAgentDescriptor,
    PairingDirectoryError,
} from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/index.ts";
import type { SessionArtifactRuntime, SessionQueryRuntime } from "../../infra/session-runtime.ts";
import type { PairingOperations } from "../pairing/pairing-operations.ts";
export class ChannelService {
    readonly #pairings: PairingOperations;
    readonly #channelGateway: ChannelGateway;
    readonly #sessionQueries: SessionQueryRuntime;
    readonly #sessionArtifacts: SessionArtifactRuntime;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
        };
        readonly runtimes: {
            readonly sessionQueries: SessionQueryRuntime;
            readonly sessionArtifacts: SessionArtifactRuntime;
        };
    }) {
        const { channelGateway } = cx.gateways;
        const { sessionQueries, sessionArtifacts } = cx.runtimes;
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

    readonly authorizeHost = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.authorizeHost(channelId, token, signal);

    readonly authorizeDaemon = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.authorizeDaemon(channelId, token, signal);

    readonly authorizeRuntime = (token: string, signal: AbortSignal) =>
        this.#pairings.authorizeRuntimeCredential(token, signal);

    private readonly authorizeChannelRuntime = async (channelId: string, token: string, signal: AbortSignal) => {
        const access = await this.#pairings.authorizeRuntimeCredential(token, signal);
        if (access.channelId !== channelId) {
            throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
        }
        return access;
    };

    readonly readArtifactContent = async (
        channelId: string,
        token: string,
        sessionId: string,
        commandId: string,
        artifactId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.authorizeChannelRuntime(channelId, token, signal);
        const scope = new ProjectScope(access.projectId);
        const runtimeId = await this.#sessionQueries.readCommandRuntime(scope, sessionId, commandId, signal);
        if (runtimeId !== access.runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The Turn is bound to another Runtime");
        }
        return await this.#sessionArtifacts.readArtifactContent(scope, sessionId, artifactId, signal);
    };

    private readonly authorizeRuntimeSession = async (
        channelId: string,
        token: string,
        sessionId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.authorizeChannelRuntime(channelId, token, signal);
        const session = await this.#sessionQueries.readSession(access.scope, sessionId, signal);
        if (session.runtimeId !== access.runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The Session is bound to another Runtime");
        }
        return access.scope;
    };

    readonly createRuntimeArtifactUpload = async (
        channelId: string,
        token: string,
        sessionId: string,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadAuthorization> => {
        const scope = await this.authorizeRuntimeSession(channelId, token, sessionId, signal);
        return await this.#sessionArtifacts.createArtifactUpload(scope, sessionId, request, now, signal);
    };

    readonly authorizeRuntimeArtifactUpload = async (
        channelId: string,
        token: string,
        sessionId: string,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadLease> => {
        const scope = await this.authorizeRuntimeSession(channelId, token, sessionId, signal);
        return await this.#sessionArtifacts.authorizeArtifactUpload(
            scope,
            sessionId,
            artifactId,
            uploadToken,
            now,
            signal,
        );
    };

    readonly completeRuntimeArtifactUpload = async (
        channelId: string,
        token: string,
        sessionId: string,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ): Promise<AvailableArtifactDescriptor> => {
        const scope = await this.authorizeRuntimeSession(channelId, token, sessionId, signal);
        if (lease.artifact.sessionId !== sessionId) {
            throw new SessionRuntimeError("session_access_denied", "The artifact upload belongs to another Session");
        }
        return await this.#sessionArtifacts.completeArtifactUpload(scope, lease, bytes, now, signal);
    };
}
