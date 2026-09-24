import {
    type CommittedSessionEvent,
    type DaemonToServiceMessage,
    encodeCommittedSessionEvent,
    encodeServiceToDaemonMessage,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { ChannelPeers, ChannelSocket, RelayClock } from "./channel-actor.ts";

export class LiveSessionEventRelay {
    readonly #clock: RelayClock;
    readonly #peers: ChannelPeers;

    constructor(clock: RelayClock, peers: ChannelPeers) {
        this.#clock = clock;
        this.#peers = peers;
    }

    readonly receive = async (
        socket: ChannelSocket,
        envelope: Extract<DaemonToServiceMessage, { readonly kind: "session.event" }>,
        signal: AbortSignal,
    ): Promise<void> => {
        validateSessionEventEnvelope(envelope);
        signal.throwIfAborted();
        const committed: CommittedSessionEvent = {
            eventId: envelope.eventId,
            kind: SESSION_EVENT_COMMITTED_KIND,
            payload: envelope.payload,
            recordedAt: new Date(this.#clock.now()).toISOString(),
            sessionId: envelope.sessionId,
            source: envelope.source,
        };
        const message = encodeCommittedSessionEvent(committed);
        for (const host of this.#peers.hosts()) {
            host.send(message);
        }
        socket.send(
            encodeServiceToDaemonMessage({
                eventId: envelope.eventId,
                kind: SESSION_EVENT_ACK_KIND,
                sessionId: envelope.sessionId,
            }),
        );
    };
}
