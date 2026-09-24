import {
    type CommittedSessionEvent,
    type DaemonToServiceMessage,
    encodeCommittedSessionEvent,
    SESSION_EVENT_COMMITTED_KIND,
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
        const committed: CommittedSessionEvent = {
            kind: SESSION_EVENT_COMMITTED_KIND,
            payload: envelope.payload,
            sessionId: envelope.sessionId,
        };
        const message = encodeCommittedSessionEvent(committed);
        for (const host of this.#peers.hosts()) {
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
    };
}
