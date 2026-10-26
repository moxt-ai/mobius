import type { AcpSessionUpdate, SessionEventPayload, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionEventPage, SessionEventStore } from "./session-event-store.ts";

/** Captures ACP updates into the V2 session event log. */
export class HistoryReplayCapture {
    readonly #events: SessionEventStore;
    readonly #sessionId: string;

    constructor(events: SessionEventStore, sessionId: string) {
        this.#events = events;
        this.#sessionId = sessionId;
    }

    readonly record = async (
        rawUpdate: AcpSessionUpdate,
        onRecorded: (event: SessionLiveEvent) => Promise<void> = () => Promise.resolve(),
    ): Promise<void> => {
        const event = this.#events.append(this.#sessionId, { payload: rawUpdate, type: "acp" });
        await onRecorded(event);
    };

    readonly recordLifecycle = (event: SessionEventPayload): SessionLiveEvent => {
        if (event.type !== "lifecycle-metadata") {
            throw new Error("Lifecycle history only accepts lifecycle metadata");
        }
        return this.#events.append(this.#sessionId, event);
    };

    readonly eventPage = (eventLimit: number, cursor: string | null): SessionEventPage =>
        this.#events.page(this.#sessionId, eventLimit, cursor);
}
