import {
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    type FileReadCommand,
    type InteractionResponse,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    SESSION_PROMPT_KIND,
    type SessionConfigurationSelection,
    type SessionElicitationRespondCommand,
    type SessionPermissionRespondCommand,
} from "@moxt-ai/mobius-protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import {
    type ArtifactUploadLease,
    type AttemptReconciliationOutcome,
    type CreateArtifactUploadRequest,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    ProjectScope,
    SessionRuntimeError,
} from "../../entity/do/session.ts";
import { PairingDirectoryError, VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import { type OperationTiming, unmeasuredOperationTiming } from "../../infra/operation-timing.ts";
import type {
    SessionArtifactRuntime,
    SessionCommandRuntime,
    SessionEventStreamRuntime,
    SessionQueryRuntime,
    SessionTransferRuntime,
} from "../../infra/session-runtime.ts";
import { RuntimeDescriptor } from "../channel/channel.ts";
export class SessionService {
    readonly #pairings: PairingOperations;
    readonly #sessionCommands: SessionCommandRuntime;
    readonly #sessionQueries: SessionQueryRuntime;
    readonly #sessionTransfers: SessionTransferRuntime;
    readonly #sessionArtifacts: SessionArtifactRuntime;
    readonly #sessionEventStreams: SessionEventStreamRuntime;
    readonly #channelGateway: ChannelGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: { readonly channelGateway: ChannelGateway };
        readonly runtimes: {
            readonly sessionCommands: SessionCommandRuntime;
            readonly sessionQueries: SessionQueryRuntime;
            readonly sessionTransfers: SessionTransferRuntime;
            readonly sessionArtifacts: SessionArtifactRuntime;
            readonly sessionEventStreams: SessionEventStreamRuntime;
        };
    }) {
        const { sessionCommands, sessionQueries, sessionTransfers, sessionArtifacts, sessionEventStreams } =
            cx.runtimes;
        this.#pairings = cx.services.pairings;
        this.#sessionCommands = sessionCommands;
        this.#sessionQueries = sessionQueries;
        this.#sessionTransfers = sessionTransfers;
        this.#sessionArtifacts = sessionArtifacts;
        this.#sessionEventStreams = sessionEventStreams;
        this.#channelGateway = cx.gateways.channelGateway;
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
            ProjectPermission.SessionWrite,
            signal,
        );
        return await this.#sessionCommands.createSession(
            new ProjectScope(access.projectId),
            request,
            access.cloudRetention,
            now,
            signal,
        );
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
                            new VerifiedChannelAccess(
                                channel.channelId,
                                channel.runtimeId,
                                channel.projectId,
                                [],
                                true,
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
            access.cloudRetention,
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

    readonly readFile = async (
        projectId: string,
        token: string,
        sessionId: string,
        path: string,
        maxBytes: number,
        signal: AbortSignal,
    ): Promise<Response> =>
        await this.streamFile(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            path,
            maxBytes,
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
        sessionConfigurations?: readonly SessionConfigurationSelection[],
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.SessionWrite, signal);
        const session = await this.#sessionQueries.readSession(scope, sessionId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            session.defaultBinding.runtimeId,
            token,
            ProjectPermission.SessionWrite,
            signal,
        );
        if (sessionConfigurations !== undefined) {
            const agent = access.agents.find((candidate) => candidate.id === session.defaultBinding.agentRef);
            if (agent?.sessionTurnConfiguration !== true) {
                throw new PairingDirectoryError(
                    "session_turn_configuration_unsupported",
                    "Update the local Mobius CLI before submitting a Turn configuration snapshot",
                );
            }
        }
        const normalizedSessionConfigurations = sessionConfigurations?.toSorted((left, right) =>
            left.configId.localeCompare(right.configId),
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
                ...(normalizedSessionConfigurations === undefined
                    ? {}
                    : { sessionConfigurations: normalizedSessionConfigurations }),
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
    ): Promise<Response> => {
        const access = await this.#pairings.authorizeProject(
            projectId,
            token,
            ProjectPermission.ProjectEventsRead,
            signal,
        );
        const streamSignal = access.lifetime.isExpiring
            ? AbortSignal.any([
                  signal,
                  AbortSignal.timeout(Math.max(0, access.lifetime.expiresAtEpochMilliseconds - Date.now())),
              ])
            : signal;
        const session = await this.#sessionQueries.readSession(access.scope, sessionId, streamSignal);
        if (!session.cloudRetention) {
            throw new SessionRuntimeError(
                "session_history_not_retained",
                "Cursor-based Session events require cloud retention",
            );
        }
        return await this.#sessionEventStreams.openEventStream(access.scope, sessionId, cursor, streamSignal);
    };

    readonly authorizeLiveEventSubscription = async (
        projectId: string,
        token: string,
        sessionId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(
            projectId,
            token,
            ProjectPermission.ProjectEventsRead,
            signal,
        );
        const session = await this.#sessionQueries.readSession(access.scope, sessionId, signal);
        if (session.cloudRetention) {
            throw new SessionRuntimeError("session_conflict", "Live Session events require non-cloud retention");
        }
        return access.lifetime.isExpiring
            ? {
                  expiresAtEpochMilliseconds: access.lifetime.expiresAtEpochMilliseconds,
                  kind: "expiring" as const,
                  projectId: access.scope.projectId,
                  runtimeId: session.runtimeId,
              }
            : {
                  kind: "durable" as const,
                  projectId: access.scope.projectId,
                  runtimeId: session.runtimeId,
              };
    };

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
        const scope = await this.projectScope(projectId, token, ProjectPermission.SessionWrite, signal);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(scope, sessionId, turnId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            runtimeId,
            token,
            ProjectPermission.SessionWrite,
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
        const scope = await this.projectScope(projectId, token, ProjectPermission.SessionWrite, signal);
        const runtimeId = await this.#sessionQueries.readTurnRuntime(scope, sessionId, turnId, signal);
        const access = await this.#pairings.authorizeProjectRuntime(
            projectId,
            runtimeId,
            token,
            ProjectPermission.SessionWrite,
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
            access.scope,
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
        timing: OperationTiming = unmeasuredOperationTiming,
    ) => {
        const scope = await timing.measure(
            "messages-authorize",
            "Authorize Session message read",
            async () => await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
        );
        return await timing.measure(
            "messages-read",
            "Read Session messages",
            async () => await this.#sessionQueries.readMessages(scope, sessionId, cursor, limit, signal, timing),
        );
    };

    readonly readEvents = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.ProjectEventsRead, signal);
        const session = await this.#sessionQueries.readSession(scope, sessionId, signal);
        if (!session.cloudRetention) {
            throw new SessionRuntimeError(
                "session_history_not_retained",
                "Cursor-based Session events require cloud retention",
            );
        }
        return await this.#sessionQueries.readEvents(scope, sessionId, cursor, limit, signal);
    };

    readonly waitForEvents = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ) => {
        const scope = await this.projectScope(projectId, token, ProjectPermission.ProjectEventsRead, signal);
        const session = await this.#sessionQueries.readSession(scope, sessionId, signal);
        if (!session.cloudRetention) {
            throw new SessionRuntimeError(
                "session_history_not_retained",
                "Cursor-based Session events require cloud retention",
            );
        }
        return await this.#sessionEventStreams.waitForEvents(scope, sessionId, cursor, limit, waitMilliseconds, signal);
    };

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

    readonly queryNativeMessages = async (
        projectId: string,
        token: string,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) =>
        this.#sessionQueries.queryNativeMessages(
            await this.projectScope(projectId, token, ProjectPermission.SessionRead, signal),
            sessionId,
            cursor,
            limit,
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

    private readonly streamFile = async (
        scope: ProjectScope,
        sessionId: string,
        path: string,
        maxBytes: number,
        signal: AbortSignal,
    ): Promise<Response> => {
        const session = await this.#sessionQueries.readSession(scope, sessionId, signal);
        const control = await this.#pairings.openProjectScopeControlHost(
            scope,
            session.defaultBinding.runtimeId,
            session.cloudRetention,
            signal,
        );
        let handedOff = false;
        try {
            const response = await this.#channelGateway.acceptHost(
                control,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                signal,
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            const command: FileReadCommand = {
                kind: "file.read",
                maxBytes,
                path,
                requestId: crypto.randomUUID(),
                sessionId,
            };
            const transfer = await requestRuntimeFile(socket, command, signal);
            handedOff = true;
            void transfer.finished
                .then(async () => {
                    await this.#pairings.closeControlHost(control, AbortSignal.timeout(15000));
                })
                .catch(() => undefined);
            return transfer.response;
        } finally {
            if (!handedOff) {
                await this.#pairings.closeControlHost(control, AbortSignal.timeout(15000));
            }
        }
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
import { requestRuntimeFile } from "../pairing/runtime-control-request.ts";
