import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import type { PairingOperations } from "./pairing-operations.ts";

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
