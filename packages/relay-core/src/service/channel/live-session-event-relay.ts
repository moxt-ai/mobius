import {
    encodeSessionEventEnvelope,
    type SessionEventEnvelope,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import type { ChannelPeers } from "./channel-actor.ts";

export class LiveSessionEventRelay {
    readonly #projectId: string;
    readonly #runtimeId: string;
    readonly #peers: ChannelPeers;
    readonly #recording: BestEffortRecording;

    constructor(projectId: string, runtimeId: string, peers: ChannelPeers, recording: BestEffortRecording) {
        this.#projectId = projectId;
        this.#runtimeId = runtimeId;
        this.#peers = peers;
        this.#recording = recording;
    }

    readonly receive = (envelope: SessionEventEnvelope): void => {
        validateSessionEventEnvelope(envelope);
        const message = encodeSessionEventEnvelope(envelope);
        for (const host of this.#peers.hosts()) {
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
        // Recording is another consumer, including when no browsers are watching.
        this.#recording.publish(
            { projectId: this.#projectId, runtimeId: this.#runtimeId, sessionId: envelope.sessionId },
            envelope,
        );
    };
}
