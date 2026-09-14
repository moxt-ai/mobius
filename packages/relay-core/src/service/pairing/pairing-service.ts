import type { WorkspaceListCommand } from "@moxt-ai/mobius-protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import {
    type RuntimeControlCommand,
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

    readonly requestControl = async (
        projectId: string,
        runtimeId: string,
        token: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const access = await this.#pairings.openControlHost(
            projectId,
            runtimeId,
            token,
            command.kind === "native.session.request" && command.action === "list"
                ? ProjectPermission.RuntimeRead
                : ProjectPermission.SessionWrite,
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
            return await requestRuntimeControl(response.webSocket, command, deadline);
        } finally {
            await this.#pairings.closeControlHost(access, AbortSignal.timeout(15000));
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

    readonly acceptProjectOwnerRuntimeHost = async (
        projectId: string,
        runtimeId: string,
        token: string,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const access = await this.#pairings.authorizeProjectOwnerRuntimeHost(projectId, runtimeId, token, signal);
        return await this.#channels.acceptHost(access, request, signal);
    };

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
