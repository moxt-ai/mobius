import type { ForkMobiusNativeSessionRequest } from "@moxt-ai/mobius-sdk";
import type { AgentSettingsDiscoverCommand, WorkspaceListCommand } from "@moxt-ai/mobius-sdk/protocol";
import { decodeRuntimeDiagnosticsRequest } from "@moxt-ai/mobius-sdk/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError, VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import { RuntimeDescriptor } from "../channel/channel.ts";
import type { LocalSessionOperations } from "../channel/local-session-operations.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { runtimeControlPermission } from "./runtime-control-registry.ts";
import type { RuntimeControlCommand } from "./runtime-control-request.ts";

export class PairingService {
    readonly #channels: ChannelGateway;
    readonly #pairings: PairingOperations;
    // Runtime operations execute only in the RuntimeRelay that owns the Runtime; every Runtime route reaches it there.
    readonly #runtimeOperations: LocalSessionOperations | undefined;

    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
            readonly runtimeOperations?: LocalSessionOperations;
        };
    }) {
        this.#channels = cx.gateways.channelGateway;
        this.#runtimeOperations = cx.gateways.runtimeOperations;
        this.#pairings = cx.services.pairings;
    }

    readonly #operations = (): LocalSessionOperations => {
        if (this.#runtimeOperations === undefined) {
            throw new Error("Runtime operations run only in the Runtime's RuntimeRelay");
        }
        return this.#runtimeOperations;
    };

    readonly createProjectRuntimePairing = (
        projectId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createProjectRuntimePairing(projectId, token, idempotencyKey, signal);

    readonly createBrowserCredential = (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => this.#pairings.createBrowserCredential(projectId, token, lifetimeMilliseconds, signal);

    readonly revokeBrowserCredential = (projectId: string, credentialId: string, token: string, signal: AbortSignal) =>
        this.#pairings.revokeBrowserCredential(projectId, credentialId, token, signal);

    readonly probeProject = async (projectId: string, token: string, signal: AbortSignal): Promise<void> => {
        await this.#pairings.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
    };

    readonly listProjectRuntimes = async (projectId: string, token: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(projectId, token, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new RuntimeDescriptor(
                        channel,
                        await this.#channels.readRuntimeStatus(
                            new VerifiedChannelAccess(channel.channelId, channel.runtimeId, channel.projectId, []),
                            signal,
                        ),
                    ),
            ),
        );
    };

    readonly getRuntimeAgents = async (projectId: string, runtimeId: string, token: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(projectId, token, signal);
        const channel = channels.find((candidate) => candidate.runtimeId === runtimeId);
        if (channel === undefined) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        return new RuntimeDescriptor(
            channel,
            await this.#channels.readRuntimeStatus(
                new VerifiedChannelAccess(channel.channelId, channel.runtimeId, channel.projectId, []),
                signal,
            ),
        );
    };

    readonly forkNativeSession = async (
        projectId: string,
        runtimeId: string,
        token: string,
        operationId: string,
        input: ForkMobiusNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(projectId, token, ProjectPermission.SessionWrite, signal);
        return await this.#operations().forkNativeSession(access.scope, runtimeId, operationId, input, signal);
    };

    readonly requestControl = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(
            projectId,
            token,
            runtimeControlPermission(command),
            signal,
        );
        return await this.#operations().requestProjectScopeControl(access.scope, runtimeId, command, signal);
    };

    readonly readRuntimeDiagnostics = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestProjectScopeControl(
            access.scope,
            runtimeId,
            decodeRuntimeDiagnosticsRequest(
                JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
            ),
            signal,
        );
    };

    readonly measureRuntimeLatency = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<number> => {
        const access = await this.#pairings.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        const started = performance.now();
        await this.#operations().requestProjectScopeControl(
            access.scope,
            runtimeId,
            { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` },
            signal,
        );
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: WorkspaceListCommand,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestWorkspace(access.scope, runtimeId, command, signal);
    };

    readonly discoverAgentSettings = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.#pairings.listProjectRuntimes(projectId, token, signal);
        if (!runtimes.some((candidate) => candidate.runtimeId === runtimeId)) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        const access = await this.#pairings.authorizeProject(projectId, token, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestAgentSettings(access.scope, runtimeId, command, signal);
    };

    readonly readProjectRuntimePairing = (projectId: string, pairingId: string, token: string, signal: AbortSignal) =>
        this.#pairings.readProjectRuntimePairing(projectId, pairingId, token, signal);

    readonly redeemRuntimePairing: PairingOperations["redeemRuntimePairing"] = async (
        pairingId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) => await this.#pairings.redeemRuntimePairing(pairingId, pairingCode, machineName, workspaceName, agents, signal);

    readonly authorizeProjectRuntimeHost = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => await this.#pairings.authorizeProjectRuntimeHost(projectId, runtimeId, token, signal);

    readonly revokeProjectRuntime = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const revoked = await this.#pairings.revokeProjectRuntime(projectId, runtimeId, token, signal);
        try {
            await this.#channels.disconnectRuntime(revoked.access, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError(
                "runtime_disconnect_failed",
                "The Runtime was revoked but its active connection could not be closed",
                { cause },
            );
        }
    };
}
