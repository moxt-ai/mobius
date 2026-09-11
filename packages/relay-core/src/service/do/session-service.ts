import {
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionPermissionRespondCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    type InteractionResponse,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    SESSION_CONFIGURE_KIND,
    SESSION_PROMPT_KIND,
    type SessionElicitationRespondCommand,
    type SessionPermissionRespondCommand,
} from "@moxt-ai/mobius-protocol";
import {
    type ConversationAccessContext,
    ConversationPermission,
} from "../../entity/authentication/conversation-access.ts";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import {
    type ArtifactUploadLease,
    type AttemptReconciliationOutcome,
    type CreateArtifactUploadRequest,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    ProjectScope,
} from "../../entity/do/session.ts";
import { VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type {
    ChannelGateway,
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "../../gateway/index.ts";
import { RuntimeDescriptor } from "../channel/channel.ts";
export class SessionService {
    readonly #pairings: PairingOperations;
    readonly #sessionCommands: SessionCommandGateway;
    readonly #sessionQueries: SessionQueryGateway;
    readonly #sessionTransfers: SessionTransferGateway;
    readonly #sessionArtifacts: SessionArtifactGateway;
    readonly #sessionEventStreams: SessionEventStreamGateway;
    readonly #channelGateway: ChannelGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly sessionCommands: SessionCommandGateway;
            readonly sessionQueries: SessionQueryGateway;
            readonly sessionTransfers: SessionTransferGateway;
            readonly sessionArtifacts: SessionArtifactGateway;
            readonly sessionEventStreams: SessionEventStreamGateway;
            readonly channelGateway: ChannelGateway;
        };
    }) {
        const {
            sessionCommands,
            sessionQueries,
            sessionTransfers,
            sessionArtifacts,
            sessionEventStreams,
            channelGateway,
        } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#sessionCommands = sessionCommands;
        this.#sessionQueries = sessionQueries;
        this.#sessionTransfers = sessionTransfers;
        this.#sessionArtifacts = sessionArtifacts;
        this.#sessionEventStreams = sessionEventStreams;
        this.#channelGateway = channelGateway;
    }
    readonly createSession = async (
        projectId: string,
        token: string,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            request.runtimeId,
            token,
            ProjectPermission.ConversationCreate,
            signal,
        );
        return await this.#sessionCommands.createSession(new ProjectScope(access.projectId), request, now, signal);
    };

    readonly createBrowserCredential = (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => this.#pairings.createBrowserCredential(projectId, token, lifetimeMilliseconds, signal);

    readonly revokeBrowserCredential = (projectId: string, credentialId: string, token: string, signal: AbortSignal) =>
        this.#pairings.revokeBrowserCredential(projectId, credentialId, token, signal);

    readonly listRuntimes = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<readonly RuntimeDescriptor[]> => {
        const channels = await this.#pairings.listProjectRuntimes(projectId, token, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new RuntimeDescriptor(
                        channel,
                        await this.#channelGateway.readRuntimeStatus(
                            new VerifiedChannelAccess(channel.channelId, channel.runtimeId, channel.projectId),
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
    ) =>
        this.#sessionQueries.listSessions(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            cursor,
            limit,
            signal,
        );

    readonly importSession = async (
        projectId: string,
        token: string,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            targetBinding.runtimeId,
            token,
            ProjectPermission.SessionWrite,
            signal,
        );
        return await this.#sessionTransfers.importSession(
            new ProjectScope(access.projectId),
            exported,
            targetBinding,
            now,
            signal,
        );
    };

    readonly readSession = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#sessionQueries.readSession(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            signal,
        );

    readonly setDefaultBinding = async (
        projectId: string,
        token: string,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            binding.runtimeId,
            token,
            ProjectPermission.SessionWrite,
            signal,
        );
        return await this.#sessionCommands.setDefaultBinding(
            new ProjectScope(access.projectId),
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
        disposition: string,
        targetCommandId: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.ConversationTurnCreate, signal);
        const session = await this.#sessionQueries.readSession(scope, sessionId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            session.defaultBinding.runtimeId,
            token,
            ProjectPermission.ConversationTurnCreate,
            signal,
        );
        const artifactResources = await this.#sessionArtifacts.resolveArtifactResources(
            scope,
            sessionId,
            artifactIds,
            signal,
        );
        const acceptance = await this.#sessionCommands.acceptTurn(
            scope,
            access.runtimeId,
            {
                additionalDirectoryIds,
                agentId: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                commandId: idempotencyKey,
                directoryId: session.defaultBinding.workspaceRef,
                disposition,
                images,
                kind: SESSION_PROMPT_KIND,
                prompt: content,
                resources: [...resources, ...artifactResources],
                sessionId,
                targetCommandId,
            },
            now,
            signal,
        );
        await this.#channelGateway.dispatchPending(access, signal);
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
        await this.#sessionArtifacts.createArtifactUpload(
            await this.projectScope(projectId, token, ProjectPermission.ArtifactWrite, signal),
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
        await this.#sessionArtifacts.authorizeArtifactUpload(
            await this.projectScope(projectId, token, ProjectPermission.ArtifactWrite, signal),
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
        await this.#sessionArtifacts.completeArtifactUpload(
            await this.projectScope(projectId, token, ProjectPermission.ArtifactWrite, signal),
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
        await this.#sessionArtifacts.readArtifact(
            await this.projectScope(projectId, token, ProjectPermission.ArtifactRead, signal),
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
        await this.#sessionArtifacts.readArtifactContent(
            await this.projectScope(projectId, token, ProjectPermission.ArtifactRead, signal),
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
        await this.#sessionEventStreams.openEventStream(
            await this.projectScope(projectId, token, ProjectPermission.ProjectEventsRead, signal),
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
    ) =>
        this.#sessionQueries.readTurn(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            turnId,
            signal,
        );

    readonly promoteQueuedTurnToSteering = async (
        projectId: string,
        token: string,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.ConversationTurnCreate, signal);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(scope, sessionId, turnId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            runtimeId,
            token,
            ProjectPermission.ConversationTurnCreate,
            signal,
        );
        const turn = await this.#sessionCommands.promoteQueuedTurnToSteering(
            scope,
            access.runtimeId,
            sessionId,
            turnId,
            now,
            signal,
        );
        await this.#channelGateway.dispatchPending(access, signal);
        return turn;
    };

    readonly cancelTurn = async (
        projectId: string,
        token: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.ConversationTurnCancel, signal);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(scope, sessionId, turnId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            runtimeId,
            token,
            ProjectPermission.ConversationTurnCancel,
            signal,
        );
        const acceptance = await this.#sessionCommands.acceptTurnCancellation(
            scope,
            access.runtimeId,
            sessionId,
            turnId,
            idempotencyKey,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channelGateway.dispatchPending(access, signal);
        }
        return acceptance.turn;
    };

    readonly readAttempt = async (
        projectId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        signal: AbortSignal,
    ) =>
        this.#sessionQueries.readAttempt(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            attemptId,
            signal,
        );

    readonly reconcileAttempt = async (
        channelId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        outcome: AttemptReconciliationOutcome,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeDaemon(channelId, token, signal);
        return await this.#sessionCommands.reconcileAttempt(
            new ProjectScope(access.projectId),
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
    ) =>
        this.#sessionQueries.readPendingInteractions(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            signal,
        );

    readonly readInteraction = async (
        projectId: string,
        token: string,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ) =>
        this.#sessionQueries.readInteraction(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
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
        this.#sessionQueries.readMessages(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            cursor,
            limit,
            signal,
        );

    readonly readEvents = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) =>
        this.#sessionQueries.readEvents(
            await this.projectScope(projectId, token, ProjectPermission.ProjectEventsRead, signal),
            sessionId,
            cursor,
            limit,
            signal,
        );

    readonly readToolCallDetail = async (
        projectId: string,
        token: string,
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ) =>
        this.#sessionQueries.readToolCallDetail(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            attemptId,
            toolCallId,
            signal,
        );

    readonly readNativeHistory = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#sessionQueries.readNativeHistory(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            signal,
        );

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
        this.#sessionCommands.recordNativeHistory(
            await this.projectScope(projectId, token, ProjectPermission.SessionWrite, signal),
            runtimeId,
            sessionId,
            title,
            history,
            now,
            signal,
        );

    readonly exportSession = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#sessionTransfers.exportSession(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            signal,
        );

    readonly deleteSession = async (
        projectId: string,
        token: string,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#sessionCommands.deleteSession(
            await this.projectScope(projectId, token, ProjectPermission.SessionDelete, signal),
            sessionId,
            now,
            signal,
        );

    readonly readConversationSession = async (access: ConversationAccessContext, signal: AbortSignal) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readSession(access.scope, access.sessionId, signal);
    };

    readonly readConversationConfiguration = async (access: ConversationAccessContext, signal: AbortSignal) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readConfiguration(access.scope, access.sessionId, signal);
    };

    readonly configureConversation = async (
        access: ConversationAccessContext,
        requestId: string,
        additionalDirectoryIds: readonly string[],
        configId: string,
        value: string,
        booleanValue: boolean,
        valueType: string,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.Configure);
        const session = await this.#sessionQueries.readSession(access.scope, access.sessionId, signal);
        const runtime = await this.#pairings.authorizeProjectScopeRuntime(
            access.scope,
            session.defaultBinding.runtimeId,
            signal,
        );
        const command = decodeSessionConfigureCommand(
            JSON.stringify({
                additionalDirectoryIds,
                agentId: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                booleanValue,
                configId,
                directoryId: session.defaultBinding.workspaceRef,
                kind: SESSION_CONFIGURE_KIND,
                requestId,
                sessionId: access.sessionId,
                value,
                valueType,
            }),
        );
        const acceptance = await this.#sessionCommands.acceptConfiguration(
            access.scope,
            runtime.runtimeId,
            command,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channelGateway.dispatchPending(runtime, signal);
        }
        return acceptance;
    };

    readonly readConversationMessages = async (
        access: ConversationAccessContext,
        cursor: Parameters<SessionQueryGateway["readMessages"]>[2],
        limit: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readMessages(access.scope, access.sessionId, cursor, limit, signal);
    };

    readonly readConversationEvents = async (
        access: ConversationAccessContext,
        cursor: Parameters<SessionQueryGateway["readEvents"]>[2],
        limit: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.EventRead);
        return await this.#sessionQueries.readEvents(access.scope, access.sessionId, cursor, limit, signal);
    };

    readonly openConversationEventStream = async (
        access: ConversationAccessContext,
        cursor: string,
        signal: AbortSignal,
    ): Promise<Response> => {
        access.require(ConversationPermission.EventRead);
        return await this.#sessionEventStreams.openEventStream(access.scope, access.sessionId, cursor, signal);
    };

    readonly readConversationTurn = async (access: ConversationAccessContext, turnId: string, signal: AbortSignal) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readTurn(access.scope, access.sessionId, turnId, signal);
    };

    readonly submitConversationTurn = async (
        access: ConversationAccessContext,
        idempotencyKey: string,
        content: string,
        disposition: string,
        targetCommandId: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.MessageCreate);
        access.require(ConversationPermission.TurnCreate);
        if (artifactIds.length > 0) {
            access.require(ConversationPermission.ArtifactRead);
        }
        const session = await this.#sessionQueries.readSession(access.scope, access.sessionId, signal);
        const runtime = await this.#pairings.authorizeProjectScopeRuntime(
            access.scope,
            session.defaultBinding.runtimeId,
            signal,
        );
        const artifactResources = await this.#sessionArtifacts.resolveArtifactResources(
            access.scope,
            access.sessionId,
            artifactIds,
            signal,
        );
        const acceptance = await this.#sessionCommands.acceptTurn(
            access.scope,
            runtime.runtimeId,
            {
                additionalDirectoryIds,
                agentId: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                commandId: idempotencyKey,
                directoryId: session.defaultBinding.workspaceRef,
                disposition,
                images,
                kind: SESSION_PROMPT_KIND,
                prompt: content,
                resources: [...resources, ...artifactResources],
                sessionId: access.sessionId,
                targetCommandId,
            },
            now,
            signal,
        );
        await this.#channelGateway.dispatchPending(runtime, signal);
        return acceptance.turn;
    };

    readonly promoteConversationTurnToSteering = async (
        access: ConversationAccessContext,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.TurnCreate);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(access.scope, access.sessionId, turnId, signal);
        const runtime = await this.#pairings.authorizeProjectScopeRuntime(access.scope, runtimeId, signal);
        const turn = await this.#sessionCommands.promoteQueuedTurnToSteering(
            access.scope,
            runtime.runtimeId,
            access.sessionId,
            turnId,
            now,
            signal,
        );
        await this.#channelGateway.dispatchPending(runtime, signal);
        return turn;
    };

    readonly cancelConversationTurn = async (
        access: ConversationAccessContext,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.TurnCancel);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(access.scope, access.sessionId, turnId, signal);
        const runtime = await this.#pairings.authorizeProjectScopeRuntime(access.scope, runtimeId, signal);
        const acceptance = await this.#sessionCommands.acceptTurnCancellation(
            access.scope,
            runtime.runtimeId,
            access.sessionId,
            turnId,
            idempotencyKey,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channelGateway.dispatchPending(runtime, signal);
        }
        return acceptance.turn;
    };

    readonly readConversationInteractions = async (access: ConversationAccessContext, signal: AbortSignal) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readPendingInteractions(access.scope, access.sessionId, signal);
    };

    readonly readConversationInteraction = async (
        access: ConversationAccessContext,
        interactionId: string,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.Read);
        return await this.#sessionQueries.readInteraction(access.scope, access.sessionId, interactionId, signal);
    };

    readonly respondToConversationPermission = async (
        access: ConversationAccessContext,
        interactionId: string,
        optionId: string,
        outcome: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const command = {
            interactionId,
            kind: "session.permission.respond",
            optionId,
            outcome,
            sessionId: access.sessionId,
        };
        return await this.respondToConversationInteraction(
            access,
            interactionId,
            {
                content: JSON.stringify({ optionId, outcome }),
                kind: "permission",
            },
            encodeSessionPermissionRespondCommand(decodeSessionPermissionRespondCommand(JSON.stringify(command))),
            now,
            signal,
        );
    };

    readonly respondToConversationElicitation = async (
        access: ConversationAccessContext,
        interactionId: string,
        action: string,
        content: unknown,
        now: number,
        signal: AbortSignal,
    ) => {
        const command = {
            action,
            content,
            interactionId,
            kind: "session.elicitation.respond",
            sessionId: access.sessionId,
        };
        return await this.respondToConversationInteraction(
            access,
            interactionId,
            {
                content: JSON.stringify({ action, content }),
                kind: "elicitation",
            },
            encodeSessionElicitationRespondCommand(decodeSessionElicitationRespondCommand(JSON.stringify(command))),
            now,
            signal,
        );
    };

    readonly createConversationArtifactUpload = async (
        access: ConversationAccessContext,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.ArtifactWrite);
        return await this.#sessionArtifacts.createArtifactUpload(access.scope, access.sessionId, request, now, signal);
    };

    readonly authorizeConversationArtifactUpload = async (
        access: ConversationAccessContext,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadLease> => {
        access.require(ConversationPermission.ArtifactWrite);
        return await this.#sessionArtifacts.authorizeArtifactUpload(
            access.scope,
            access.sessionId,
            artifactId,
            uploadToken,
            now,
            signal,
        );
    };

    readonly completeConversationArtifactUpload = async (
        access: ConversationAccessContext,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.ArtifactWrite);
        return await this.#sessionArtifacts.completeArtifactUpload(access.scope, lease, bytes, now, signal);
    };

    readonly readConversationArtifact = async (
        access: ConversationAccessContext,
        artifactId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.ArtifactRead);
        return await this.#sessionArtifacts.readArtifact(access.scope, access.sessionId, artifactId, now, signal);
    };

    readonly readConversationArtifactContent = async (
        access: ConversationAccessContext,
        artifactId: string,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.ArtifactRead);
        return await this.#sessionArtifacts.readArtifactContent(access.scope, access.sessionId, artifactId, signal);
    };

    private readonly respondToConversationInteraction = async (
        access: ConversationAccessContext,
        interactionId: string,
        response: InteractionResponse,
        deliveryPayload: string,
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.InteractionRespond);
        const runtimeId = await this.#sessionQueries.readInteractionRuntime(
            access.scope,
            access.sessionId,
            interactionId,
            signal,
        );
        const runtime = await this.#pairings.authorizeProjectScopeRuntime(access.scope, runtimeId, signal);
        const acceptance = await this.#sessionCommands.acceptInteractionResponse(
            access.scope,
            access.sessionId,
            interactionId,
            access.actorReference,
            response,
            deliveryPayload,
            now,
            signal,
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await this.#channelGateway.dispatchPending(runtime, signal);
        }
        return acceptance.interaction;
    };

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
        const scope = await this.projectScope(projectId, token, ProjectPermission.InteractionRespond, signal);
        const runtimeId = await this.#sessionQueries.readInteractionRuntime(scope, sessionId, interactionId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            runtimeId,
            token,
            ProjectPermission.InteractionRespond,
            signal,
        );
        const acceptance = await this.#sessionCommands.acceptInteractionResponse(
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
            await this.#channelGateway.dispatchPending(access, signal);
        }
        return acceptance.interaction;
    };

    private readonly projectScope = async (
        projectId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectScope> => {
        const access = await this.#pairings.authorizeProject(projectId, token, permission, signal);
        return access.scope;
    };
}

import type { PairingOperations } from "../pairing/pairing-operations.ts";
