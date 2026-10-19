import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate, SessionEventPayload, SessionLiveEvent } from "@moxt-ai/mobius-protocol";
import type { AcpSessionEventStore } from "./session-event-store.ts";

/**
 * Captures ACP load replay into the V2 session event log without turning
 * historical updates into live turns.
 */
export class AcpHistoryReplay {
    readonly #events: AcpSessionEventStore;
    readonly #sessionId: string;

    constructor(events: AcpSessionEventStore, sessionId: string) {
        this.#events = events;
        this.#sessionId = sessionId;
    }

    readonly record = async (
        _update: SessionNotification["update"],
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

    readonly eventPage = (
        eventLimit: number,
        cursor: string | null,
    ): import("./session-contracts.ts").AcpNativeEventReplay => this.#events.page(this.#sessionId, eventLimit, cursor);
}
