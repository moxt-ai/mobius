import type { AgentSettingsDiscoverCommand, FileReadCommand, WorkspaceListCommand } from "@moxt-ai/mobius-sdk/protocol";
import { decodeRuntimeDiagnosticsRequest } from "@moxt-ai/mobius-sdk/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import { PairingDirectoryError, VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import { type OperationTiming, unmeasuredOperationTiming } from "../../infra/operation-timing.ts";
import { RuntimeDescriptor } from "../channel/channel.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import {
    type RuntimeControlCommand,
    requestRuntimeAgentSettings,
    requestRuntimeControl,
    requestRuntimeFile,
    requestRuntimeWorkspace,
} from "./runtime-control-request.ts";

export class PairingService {
    readonly #channels: ChannelGateway;
    readonly #pairings: PairingOperations;

    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
        };
    }) {
        this.#channels = cx.gateways.channelGateway;
        this.#pairings = cx.services.pairings;
    }

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

    readonly requestControl = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
        timing: OperationTiming = unmeasuredOperationTiming,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const access = await timing.measure(
            "control-authorize",
            "Authorize Runtime control host",
            async () =>
                await this.#pairings.openControlHost(
                    projectId,
                    runtimeId,
                    token,
                    (command.kind === "native.session.request" && command.action === "list") ||
                        command.kind === "session.list" ||
                        command.kind === "session.query" ||
                        command.kind === "session.preview-history.page.load" ||
                        command.kind === "session.live-history.v2.page.load"
                        ? ProjectPermission.RuntimeRead
                        : ProjectPermission.SessionWrite,
                    deadline,
                ),
        );
        try {
            const response = await timing.measure("control-connect", "Connect Runtime control host", async () =>
                command.kind === "native.session.request"
                    ? await this.#channels.acceptNativeRequest(access, command.requestId, deadline)
                    : await this.#channels.acceptHost(
                          access,
                          new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                          deadline,
                      ),
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            return await timing.measure(
                "control-runtime",
                "Wait for Runtime control response",
                async () => await requestRuntimeControl(socket, command, deadline),
            );
        } finally {
            await timing.measure(
                "control-close",
                "Close Runtime control host",
                async () => await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000)),
            );
        }
    };

    readonly readRuntimeDiagnostics = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
        const access = await this.#pairings.openControlHost(
            projectId,
            runtimeId,
            token,
            ProjectPermission.RuntimeRead,
            deadline,
        );
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            if (response.webSocket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            return await requestRuntimeControl(
                response.webSocket,
                decodeRuntimeDiagnosticsRequest(
                    JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
                ),
                deadline,
            );
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15_000));
        }
    };

    readonly measureRuntimeLatency = async (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<number> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const access = await this.#pairings.openControlHost(
            projectId,
            runtimeId,
            token,
            ProjectPermission.RuntimeRead,
            deadline,
        );
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            const startedAt = performance.now();
            await requestRuntimeControl(
                socket,
                { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` },
                deadline,
            );
            return Math.max(0, Math.round(performance.now() - startedAt));
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15_000));
        }
    };

    readonly requestProjectScopeControl = async (
        scope: ProjectScope,
        runtimeId: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const access = await this.#pairings.openProjectScopeControlHost(scope, runtimeId, deadline);
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            return await requestRuntimeControl(socket, command, deadline);
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
        }
    };

    readonly openProjectSessionEventHost = async (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<{ readonly close: () => Promise<void>; readonly socket: WebSocket }> => {
        const access = await this.#pairings.openProjectScopeControlHost(scope, runtimeId, signal);
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                signal,
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            let closed = false;
            return {
                socket,
                close: async () => {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    socket.close(1000, "Session event subscription closed");
                    await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
                },
            };
        } catch (cause) {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
            throw cause;
        }
    };

    readonly readProjectSessionFile = async (
        scope: ProjectScope,
        runtimeId: string,
        command: FileReadCommand,
        signal: AbortSignal,
    ): Promise<Response> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const access = await this.#pairings.openProjectScopeControlHost(scope, runtimeId, deadline);
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            const stream = await requestRuntimeFile(socket, command, deadline);
            void (async () => {
                try {
                    await stream.finished;
                } finally {
                    await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
                }
            })().catch(() => undefined);
            return stream.response;
        } catch (cause) {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
            throw cause;
        }
    };

    readonly listWorkspace = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: WorkspaceListCommand,
        signal: AbortSignal,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const access = await this.#pairings.openControlHost(
            projectId,
            runtimeId,
            token,
            ProjectPermission.RuntimeRead,
            deadline,
        );
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            if (response.webSocket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            return await requestRuntimeWorkspace(response.webSocket, command, deadline);
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
        }
    };

    readonly discoverAgentSettings = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const runtimes = await this.#pairings.listProjectRuntimes(projectId, token, deadline);
        const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId);
        if (runtime === undefined) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        const agent = runtime.agents.find((candidate) => candidate.id === command.agentId);
        if (agent?.agentSettingsDiscovery !== true) {
            throw new PairingDirectoryError(
                "agent_settings_discovery_unsupported",
                "The selected local Agent does not support settings discovery",
            );
        }
        const access = await this.#pairings.openControlHost(
            projectId,
            runtimeId,
            token,
            ProjectPermission.RuntimeRead,
            deadline,
        );
        try {
            const response = await this.#channels.acceptHost(
                access,
                new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                deadline,
            );
            if (response.webSocket === null) {
                throw new PairingDirectoryError("runtime_unavailable", "The Runtime connection is unavailable");
            }
            return await requestRuntimeAgentSettings(response.webSocket, command, deadline);
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
        }
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
