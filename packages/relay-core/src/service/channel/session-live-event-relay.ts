import { encodeSessionEventEnvelope, type SessionEventEnvelope } from "@moxt-ai/mobius-sdk/protocol";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import type { ChannelPeers } from "./channel-actor.ts";

export class SessionLiveEventRelay {
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
        const eventsBySession = new Map<string, (typeof envelope.events)[number][]>();
        for (const event of envelope.events) {
            const events = eventsBySession.get(event.sessionId) ?? [];
            events.push(event);
            eventsBySession.set(event.sessionId, events);
        }
        let runtimeMessage: string | undefined;
        const sessionMessages = new Map<string, string>();
        for (const host of this.#peers.hosts()) {
            const sessionFilter = host.sessionFilter;
            let message: string;
            if (sessionFilter === undefined) {
                runtimeMessage ??= encodeSessionEventEnvelope(envelope);
                message = runtimeMessage;
            } else {
                const events = eventsBySession.get(sessionFilter);
                if (events === undefined) {
                    continue;
                }
                const encoded =
                    sessionMessages.get(sessionFilter) ?? encodeSessionEventEnvelope({ events, kind: envelope.kind });
                sessionMessages.set(sessionFilter, encoded);
                message = encoded;
            }
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
        // Recording is another consumer, including when no browsers are watching.
        for (const [sessionId, events] of eventsBySession) {
            this.#recording.publish(
                { projectId: this.#projectId, runtimeId: this.#runtimeId, sessionId },
                { events, kind: envelope.kind },
            );
        }
    };
}
