import {
    type DaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    encodeSessionEventEnvelope,
    type ReliableSessionEventEnvelope,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SessionEventRejectionCode,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { SessionRecording } from "../../infra/session-recording.ts";
import type { SessionEventReceiptStorage } from "../../storage/session-event-receipt-storage.ts";
import type { ChannelPeers, ChannelSocket } from "./channel-actor.ts";

async function sha256(value: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    signal.throwIfAborted();
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class LiveSessionEventRelay {
    readonly #peers: ChannelPeers;
    readonly #projectId: string;
    readonly #receipts: SessionEventReceiptStorage;
    readonly #recording: SessionRecording;
    readonly #now: () => number;

    constructor(
        projectId: string,
        peers: ChannelPeers,
        recording: SessionRecording,
        receipts: SessionEventReceiptStorage,
        now: () => number,
    ) {
        this.#now = now;
        this.#projectId = projectId;
        this.#peers = peers;
        this.#receipts = receipts;
        this.#recording = recording;
    }

    readonly receive = (
        daemon: ChannelSocket,
        envelope: Extract<DaemonToServiceMessage, { readonly kind: "session.event" }>,
        signal: AbortSignal,
    ): Promise<void> => {
        validateSessionEventEnvelope(envelope);
        signal.throwIfAborted();
        if (!("delivery" in envelope)) {
            this.broadcast(encodeSessionEventEnvelope(envelope));
            return Promise.resolve();
        }

        return this.receiveReliable(daemon, envelope, signal);
    };

    private readonly receiveReliable = async (
        daemon: ChannelSocket,
        envelope: ReliableSessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<void> => {
        const encodedEnvelope = encodeSessionEventEnvelope(envelope);
        const receipt = this.#receipts.claim(
            envelope.delivery.eventId,
            await sha256(encodedEnvelope, signal),
            this.#now(),
        );
        if (receipt.kind === "conflict") {
            daemon.send(
                encodeServiceToDaemonMessage({
                    code: SessionEventRejectionCode.IdempotencyConflict,
                    eventId: envelope.delivery.eventId,
                    kind: SESSION_EVENT_REJECTED_KIND,
                    sessionId: envelope.sessionId,
                }),
            );
            return;
        }
        if (receipt.kind === "accepted") {
            this.broadcast(
                encodeSessionEventEnvelope({
                    kind: envelope.kind,
                    payload: envelope.payload,
                    sessionId: envelope.sessionId,
                }),
            );
        }

        signal.throwIfAborted();
        const result = await this.#recording.deliver(
            { projectId: this.#projectId, sessionId: envelope.sessionId },
            envelope,
            signal,
        );
        signal.throwIfAborted();
        if (result.kind === "deferred") {
            daemon.send(
                encodeServiceToDaemonMessage({
                    eventId: envelope.delivery.eventId,
                    kind: SESSION_EVENT_DEFERRED_KIND,
                    retryAfterMilliseconds: result.retryAfterMilliseconds,
                    sessionId: envelope.sessionId,
                }),
            );
            return;
        }
        if (result.kind === "rejected") {
            daemon.send(
                encodeServiceToDaemonMessage({
                    code: result.code,
                    eventId: envelope.delivery.eventId,
                    kind: SESSION_EVENT_REJECTED_KIND,
                    sessionId: envelope.sessionId,
                }),
            );
            return;
        }
        daemon.send(
            encodeServiceToDaemonMessage({
                eventId: envelope.delivery.eventId,
                kind: SESSION_EVENT_ACK_KIND,
                outcome:
                    result.kind === "relayed"
                        ? { kind: "relayed" }
                        : {
                              kind: "recorded",
                              providerId: result.providerId,
                              recordingEpoch: result.recordingEpoch,
                          },
                sessionId: envelope.sessionId,
            }),
        );
    };

    private readonly broadcast = (message: string): void => {
        for (const host of this.#peers.hosts()) {
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
    };
}
