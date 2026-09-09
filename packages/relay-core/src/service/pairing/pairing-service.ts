import type { ChannelGateway, PairingGateway } from "../../gateway/index.ts";
import { PairingDirectoryError } from "./pairing.ts";

export class PairingService {
    readonly #channels: ChannelGateway;
    readonly #pairings: PairingGateway;

    constructor(cx: {
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
            readonly pairingGateway: PairingGateway;
        };
    }) {
        this.#channels = cx.gateways.channelGateway;
        this.#pairings = cx.gateways.pairingGateway;
    }

    readonly createProjectRuntimePairing = (
        projectId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createProjectRuntimePairing(projectId, token, idempotencyKey, signal);

    readonly readProjectRuntimePairing = (projectId: string, pairingId: string, token: string, signal: AbortSignal) =>
        this.#pairings.readProjectRuntimePairing(projectId, pairingId, token, signal);

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
