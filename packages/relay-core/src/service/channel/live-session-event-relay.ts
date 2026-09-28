import {
    type DaemonToServiceMessage,
    encodeSessionEventEnvelope,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { ChannelPeers } from "./channel-actor.ts";

export class LiveSessionEventRelay {
    readonly #peers: ChannelPeers;

    constructor(peers: ChannelPeers) {
        this.#peers = peers;
    }

    readonly receive = (
        envelope: Extract<DaemonToServiceMessage, { readonly kind: "session.event" }>,
        signal: AbortSignal,
    ): void => {
        validateSessionEventEnvelope(envelope);
        signal.throwIfAborted();
        const message = encodeSessionEventEnvelope(envelope);
        for (const host of this.#peers.hosts()) {
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
    };
}
