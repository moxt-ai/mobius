import {
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    type InteractionResponse,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    SESSION_PROMPT_KIND,
    type SessionElicitationRespondCommand,
    type SessionPermissionRespondCommand,
} from "@moxt-ai/mobius-protocol";

import { type ChannelRuntime, RuntimeDescriptor } from "./channel-runtime.ts";
import {
    type AgentDescriptor,
    type InstallableAgentDescriptor,
    type PairingDirectory,
    VerifiedChannelAccess,
} from "./pairing-directory.ts";
import {
    type ArtifactUploadLease,
    type AttemptReconciliationOutcome,
    type CreateArtifactUploadRequest,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    ProjectScope,
    type SessionRuntime,
    SessionRuntimeError,
} from "./session-runtime.ts";

export interface RelayPorts {
    readonly channelRuntime: ChannelRuntime;
    readonly pairingDirectory: PairingDirectory;
    readonly sessionRuntime: SessionRuntime;
}

export class PairingUseCases {
    readonly #directory: PairingDirectory;

    constructor(directory: PairingDirectory) {
        this.#directory = directory;
    }

    readonly createPairing = (signal: AbortSignal) => this.#directory.createPairing(signal);

    readonly readPairingStatus = (pairingId: string, pollToken: string, signal: AbortSignal) =>
        this.#directory.readPairingStatus(pairingId, pollToken, signal);

    readonly claimPairing = (
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => this.#directory.claimPairing(pairingCode, machineName, workspaceName, agents, installableAgents, signal);
}

export class ChannelUseCases {
    readonly #directory: PairingDirectory;
    readonly #runtime: ChannelRuntime;
    readonly #sessions: SessionRuntime;

    constructor(directory: PairingDirectory, runtime: ChannelRuntime, sessions: SessionRuntime) {
        this.#directory = directory;
        this.#runtime = runtime;
        this.#sessions = sessions;
    }

    readonly updateAgentCatalog = (
        channelId: string,
        token: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => this.#directory.updateAgentCatalog(channelId, token, agents, installableAgents, signal);

    readonly createAccessGrant = (channelId: string, token: string, signal: AbortSignal) =>
        this.#directory.createChannelAccessGrant(channelId, token, signal);

    readonly redeemAccessGrant = (channelId: string, grantId: string, grantSecret: string, signal: AbortSignal) =>
        this.#directory.redeemChannelAccessGrant(channelId, grantId, grantSecret, signal);

    readonly listLinkedDevices = (channelId: string, token: string, signal: AbortSignal) =>
        this.#directory.listLinkedChannelDevices(channelId, token, signal);

    readonly revokeLinkedDevice = async (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const credential = await this.#directory.revokeLinkedChannelDevice(channelId, credentialId, token, signal);
        await this.#runtime.disconnectHost(credential, signal);
    };

    readonly readChannel = (channelId: string, token: string, signal: AbortSignal) =>
        this.#directory.readChannel(channelId, token, signal);

    readonly acceptHost = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#directory.authorizeHost(channelId, token, signal);
        return await this.#runtime.acceptHost(access, request, signal);
    };

    readonly acceptDaemon = async (
        channelId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#directory.authorizeDaemon(channelId, token, signal);
        return await this.#runtime.acceptDaemon(access, request, signal);
    };

    readonly readArtifactContent = async (
        channelId: string,
        token: string,
        sessionId: string,
        commandId: string,
        artifactId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.#directory.authorizeDaemon(channelId, token, signal);
        const scope = new ProjectScope(access.tenantId, access.projectId);
        const runtimeId = await this.#sessions.readCommandRuntime(scope, sessionId, commandId, signal);
        if (runtimeId !== access.runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The Turn is bound to another Runtime");
        }
        return await this.#sessions.readArtifactContent(scope, sessionId, artifactId, signal);
    };
}

export class SessionUseCases {
    readonly #channels: ChannelRuntime;
    readonly #directory: PairingDirectory;
    readonly #runtime: SessionRuntime;

    constructor(directory: PairingDirectory, runtime: SessionRuntime, channels: ChannelRuntime) {
        this.#channels = channels;
        this.#directory = directory;
        this.#runtime = runtime;
    }

    readonly createSession = async (
        projectId: string,
        token: string,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#directory.authorizeProjectRuntime(projectId, request.runtimeId, token, signal);
        return await this.#runtime.createSession(
            new ProjectScope(access.tenantId, access.projectId),
            request,
            now,
            signal,
        );
    };

    readonly createBrowserCredential = (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => this.#directory.createBrowserCredential(projectId, token, lifetimeMilliseconds, signal);

    readonly revokeBrowserCredential = (projectId: string, credentialId: string, token: string, signal: AbortSignal) =>
        this.#directory.revokeBrowserCredential(projectId, credentialId, token, signal);

    readonly listRuntimes = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<readonly RuntimeDescriptor[]> => {
        const channels = await this.#directory.listProjectRuntimes(projectId, token, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new RuntimeDescriptor(
                        channel,
                        await this.#channels.readRuntimeStatus(
                            new VerifiedChannelAccess(
                                channel.channelId,
                                channel.runtimeId,
                                channel.tenantId,
                                channel.projectId,
                            ),
                            signal,
                        ),
                    ),
            ),
        );
    };

    readonly listSessions = async (
        projectId: string,
        token: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => this.#runtime.listSessions(await this.projectScope(projectId, token, signal), cursor, limit, signal);

    readonly importSession = async (
        projectId: string,
        token: string,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#directory.authorizeProjectRuntime(projectId, targetBinding.runtimeId, token, signal);
        return await this.#runtime.importSession(
            new ProjectScope(access.tenantId, access.projectId),
            exported,
            targetBinding,
            now,
            signal,
        );
    };

    readonly readSession = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#runtime.readSession(await this.projectScope(projectId, token, signal), sessionId, signal);

    readonly setDefaultBinding = async (
        projectId: string,
        token: string,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#directory.authorizeProjectRuntime(projectId, binding.runtimeId, token, signal);
        return await this.#runtime.setDefaultBinding(
            new ProjectScope(access.tenantId, access.projectId),
            sessionId,
            binding,
            now,
            signal,
        );
    };

    readonly submitTurn = async (
        projectId: string,
        token: string,
        sessionId: string,
        idempotencyKey: string,
        content: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, signal);
        const session = await this.#runtime.readSession(scope, sessionId, signal);
        const access = await this.#directory.authorizeProjectRuntime(
            projectId,
            session.defaultBinding.runtimeId,
            token,
            signal,
        );
        const artifactResources = await this.#runtime.resolveArtifactResources(scope, sessionId, artifactIds, signal);
        const acceptance = await this.#runtime.acceptTurn(
            scope,
            access.runtimeId,
            {
                additionalDirectoryIds,
                agentId: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                commandId: idempotencyKey,
                directoryId: session.defaultBinding.workspaceRef,
                images,
                kind: SESSION_PROMPT_KIND,
                prompt: content,
                resources: [...resources, ...artifactResources],
                sessionId,
            },
            now,
            signal,
        );
        await this.#channels.dispatchPending(access, signal);
        return acceptance.turn;
    };

    readonly createArtifactUpload = async (
        projectId: string,
        token: string,
        sessionId: string,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ) =>
        await this.#runtime.createArtifactUpload(
            await this.projectScope(projectId, token, signal),
            sessionId,
            request,
            now,
            signal,
        );

    readonly authorizeArtifactUpload = async (
        projectId: string,
        token: string,
        sessionId: string,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadLease> =>
        await this.#runtime.authorizeArtifactUpload(
            await this.projectScope(projectId, token, signal),
            sessionId,
            artifactId,
            uploadToken,
            now,
            signal,
        );

    readonly completeArtifactUpload = async (
        projectId: string,
        token: string,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ) =>
        await this.#runtime.completeArtifactUpload(
            await this.projectScope(projectId, token, signal),
            lease,
            bytes,
            now,
            signal,
        );

    readonly readArtifact = async (
        projectId: string,
        token: string,
        sessionId: string,
        artifactId: string,
        now: number,
        signal: AbortSignal,
    ) =>
        await this.#runtime.readArtifact(
            await this.projectScope(projectId, token, signal),
            sessionId,
            artifactId,
            now,
            signal,
        );

    readonly readArtifactContent = async (
        projectId: string,
        token: string,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ) =>
        await this.#runtime.readArtifactContent(
            await this.projectScope(projectId, token, signal),
            sessionId,
            artifactId,
            signal,
        );

    readonly openEventStream = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ): Promise<Response> =>
        await this.#runtime.openEventStream(
            await this.projectScope(projectId, token, signal),
            sessionId,
            cursor,
            signal,
        );

    readonly readTurn = async (
        projectId: string,
        token: string,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ) => this.#runtime.readTurn(await this.projectScope(projectId, token, signal), sessionId, turnId, signal);

    readonly cancelTurn = async (
        projectId: string,
        token: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, signal);
        const runtimeId = await this.#runtime.readTurnRuntime(scope, sessionId, turnId, signal);
        const access = await this.#directory.authorizeProjectRuntime(projectId, runtimeId, token, signal);
        const acceptance = await this.#runtime.acceptTurnCancellation(
            scope,
            access.runtimeId,
            sessionId,
            turnId,
            idempotencyKey,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channels.dispatchPending(access, signal);
        }
        return acceptance.turn;
    };

    readonly readAttempt = async (
        projectId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        signal: AbortSignal,
    ) => this.#runtime.readAttempt(await this.projectScope(projectId, token, signal), sessionId, attemptId, signal);

    readonly reconcileAttempt = async (
        channelId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        outcome: AttemptReconciliationOutcome,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#directory.authorizeDaemon(channelId, token, signal);
        return await this.#runtime.reconcileAttempt(
            new ProjectScope(access.tenantId, access.projectId),
            access.runtimeId,
            sessionId,
            attemptId,
            outcome,
            now,
            signal,
        );
    };

    readonly readPendingInteractions = async (
        projectId: string,
        token: string,
        sessionId: string,
        signal: AbortSignal,
    ) => this.#runtime.readPendingInteractions(await this.projectScope(projectId, token, signal), sessionId, signal);

    readonly readInteraction = async (
        projectId: string,
        token: string,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ) =>
        this.#runtime.readInteraction(
            await this.projectScope(projectId, token, signal),
            sessionId,
            interactionId,
            signal,
        );

    readonly respondToPermission = async (
        projectId: string,
        token: string,
        responderId: string,
        command: SessionPermissionRespondCommand,
        now: number,
        signal: AbortSignal,
    ) =>
        await this.respondToInteraction(
            projectId,
            token,
            responderId,
            command.sessionId,
            command.interactionId,
            {
                content: JSON.stringify({
                    optionId: command.optionId,
                    outcome: command.outcome,
                }),
                kind: "permission",
            },
            encodeSessionPermissionRespondCommand(command),
            now,
            signal,
        );

    readonly respondToElicitation = async (
        projectId: string,
        token: string,
        responderId: string,
        command: SessionElicitationRespondCommand,
        now: number,
        signal: AbortSignal,
    ) =>
        await this.respondToInteraction(
            projectId,
            token,
            responderId,
            command.sessionId,
            command.interactionId,
            {
                content: JSON.stringify({
                    action: command.action,
                    content: command.content,
                }),
                kind: "elicitation",
            },
            encodeSessionElicitationRespondCommand(command),
            now,
            signal,
        );

    readonly readMessages = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) =>
        this.#runtime.readMessages(await this.projectScope(projectId, token, signal), sessionId, cursor, limit, signal);

    readonly readEvents = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => this.#runtime.readEvents(await this.projectScope(projectId, token, signal), sessionId, cursor, limit, signal);

    readonly readToolCallDetail = async (
        projectId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ) =>
        this.#runtime.readToolCallDetail(
            await this.projectScope(projectId, token, signal),
            sessionId,
            attemptId,
            toolCallId,
            signal,
        );

    readonly readNativeHistory = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#runtime.readNativeHistory(await this.projectScope(projectId, token, signal), sessionId, signal);

    readonly recordNativeHistory = async (
        projectId: string,
        token: string,
        runtimeId: string,
        sessionId: string,
        title: string,
        history: NativeSessionHistory,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#runtime.recordNativeHistory(
            await this.projectScope(projectId, token, signal),
            runtimeId,
            sessionId,
            title,
            history,
            now,
            signal,
        );

    readonly exportSession = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#runtime.exportSession(await this.projectScope(projectId, token, signal), sessionId, signal);

    readonly deleteSession = async (
        projectId: string,
        token: string,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ) => this.#runtime.deleteSession(await this.projectScope(projectId, token, signal), sessionId, now, signal);

    private readonly respondToInteraction = async (
        projectId: string,
        token: string,
        responderId: string,
        sessionId: string,
        interactionId: string,
        response: InteractionResponse,
        deliveryPayload: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, signal);
        const runtimeId = await this.#runtime.readInteractionRuntime(scope, sessionId, interactionId, signal);
        const access = await this.#directory.authorizeProjectRuntime(projectId, runtimeId, token, signal);
        const acceptance = await this.#runtime.acceptInteractionResponse(
            scope,
            sessionId,
            interactionId,
            responderId,
            response,
            deliveryPayload,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channels.dispatchPending(access, signal);
        }
        return acceptance.interaction;
    };

    private readonly projectScope = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ProjectScope> => {
        const access = await this.#directory.authorizeProject(projectId, token, signal);
        return new ProjectScope(access.tenantId, access.projectId);
    };
}

export class RelayUseCases {
    static readonly inject = ["channelRuntime", "pairingDirectory", "sessionRuntime"] satisfies readonly [
        "channelRuntime",
        "pairingDirectory",
        "sessionRuntime",
    ];

    readonly channels: ChannelUseCases;
    readonly pairings: PairingUseCases;
    readonly sessions: SessionUseCases;

    constructor(channelRuntime: ChannelRuntime, pairingDirectory: PairingDirectory, sessionRuntime: SessionRuntime) {
        this.channels = new ChannelUseCases(pairingDirectory, channelRuntime, sessionRuntime);
        this.pairings = new PairingUseCases(pairingDirectory);
        this.sessions = new SessionUseCases(pairingDirectory, sessionRuntime, channelRuntime);
    }
}
