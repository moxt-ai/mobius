import {
    type CommittedSessionEvent,
    type DaemonToServiceMessage,
    encodeCommittedSessionEvent,
    encodeServiceToDaemonMessage,
    ProtocolMessageError,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { ChannelPeers, ChannelSocket, RelayClock } from "./channel-actor.ts";

async function payloadDigest(payload: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class LiveSessionEventRelay {
    readonly #clock: RelayClock;
    readonly #peers: ChannelPeers;
    readonly #receipts = new Map<string, { readonly digest: string; readonly sequence: string }>();
    #sequence = 0n;

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
        const receiptKey = `${envelope.sessionId}\u0000${envelope.eventId}`;
        const digest = await payloadDigest(envelope.payload);
        signal.throwIfAborted();
        const existing = this.#receipts.get(receiptKey);
        if (existing !== undefined) {
            if (existing.digest !== digest) {
                throw new ProtocolMessageError("A Session event ID was reused with different content");
            }
            socket.send(
                encodeServiceToDaemonMessage({
                    cursor: envelope.eventId,
                    duplicate: true,
                    eventId: envelope.eventId,
                    kind: SESSION_EVENT_ACK_KIND,
                    sequence: existing.sequence,
                    sessionId: envelope.sessionId,
                }),
            );
            return;
        }
        const timeSequence = BigInt(this.#clock.now()) * 1_000_000n;
        this.#sequence = this.#sequence >= timeSequence ? this.#sequence + 1n : timeSequence;
        const sequence = String(this.#sequence);
        const committed: CommittedSessionEvent = {
            cursor: envelope.eventId,
            eventId: envelope.eventId,
            kind: SESSION_EVENT_COMMITTED_KIND,
            payload: envelope.payload,
            recordedAt: new Date(this.#clock.now()).toISOString(),
            sequence,
            sessionId: envelope.sessionId,
            source: envelope.source,
        };
        const message = encodeCommittedSessionEvent(committed);
        for (const host of this.#peers.hosts()) {
            host.send(message);
        }
        if (this.#receipts.size >= 10_000) {
            const oldest = this.#receipts.keys().next().value;
            if (oldest !== undefined) {
                this.#receipts.delete(oldest);
            }
        }
        this.#receipts.set(receiptKey, { digest, sequence });
        socket.send(
            encodeServiceToDaemonMessage({
                cursor: envelope.eventId,
                duplicate: false,
                eventId: envelope.eventId,
                kind: SESSION_EVENT_ACK_KIND,
                sequence,
                sessionId: envelope.sessionId,
            }),
        );
    };
}
