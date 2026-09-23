import type {
    AgentCatalogRefreshCommand,
    AgentSettingsDiscoverCommand,
    WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import { type OperationTiming, unmeasuredOperationTiming } from "../../infra/operation-timing.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import {
    type RuntimeControlCommand,
    requestRuntimeAgentCatalogRefresh,
    requestRuntimeAgentSettings,
    requestRuntimeControl,
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

    readonly listProjectRuntimes = (projectId: string, token: string, signal: AbortSignal) =>
        this.#pairings.listProjectRuntimes(projectId, token, signal);

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
                    command.kind === "native.session.request" && command.action === "list"
                        ? ProjectPermission.RuntimeRead
                        : ProjectPermission.SessionWrite,
                    deadline,
                ),
        );
        try {
            const response = await timing.measure(
                "control-connect",
                "Connect Runtime control host",
                async () =>
                    await this.#channels.acceptHost(
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

    readonly refreshAgentCatalog = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: AgentCatalogRefreshCommand,
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
            await requestRuntimeAgentCatalogRefresh(response.webSocket, command, deadline);
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
        installableAgents,
        signal,
    ) =>
        await this.#pairings.redeemRuntimePairing(
            pairingId,
            pairingCode,
            machineName,
            workspaceName,
            agents,
            installableAgents,
            signal,
        );

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
