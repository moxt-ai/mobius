import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";

import type { ChannelRuntime } from "./channel-runtime.ts";
import type { AgentDescriptor, InstallableAgentDescriptor, PairingDirectory } from "./pairing-directory.ts";
import {
    type AttemptReconciliationOutcome,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    ProjectScope,
    type SessionRuntime,
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

    constructor(directory: PairingDirectory, runtime: ChannelRuntime) {
        this.#directory = directory;
        this.#runtime = runtime;
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
}

export class SessionUseCases {
    readonly #directory: PairingDirectory;
    readonly #runtime: SessionRuntime;

    constructor(directory: PairingDirectory, runtime: SessionRuntime) {
        this.#directory = directory;
        this.#runtime = runtime;
    }

    readonly createSession = async (
        projectId: string,
        token: string,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ) => this.#runtime.createSession(await this.projectScope(projectId, token, signal), request, now, signal);

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
        now: number,
        signal: AbortSignal,
    ) => this.#runtime.importSession(await this.projectScope(projectId, token, signal), exported, now, signal);

    readonly readSession = async (projectId: string, token: string, sessionId: string, signal: AbortSignal) =>
        this.#runtime.readSession(await this.projectScope(projectId, token, signal), sessionId, signal);

    readonly setDefaultBinding = async (
        projectId: string,
        token: string,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#runtime.setDefaultBinding(
            await this.projectScope(projectId, token, signal),
            sessionId,
            binding,
            now,
            signal,
        );

    readonly readTurn = async (
        projectId: string,
        token: string,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ) => this.#runtime.readTurn(await this.projectScope(projectId, token, signal), sessionId, turnId, signal);

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
        this.channels = new ChannelUseCases(pairingDirectory, channelRuntime);
        this.pairings = new PairingUseCases(pairingDirectory);
        this.sessions = new SessionUseCases(pairingDirectory, sessionRuntime);
    }
}
