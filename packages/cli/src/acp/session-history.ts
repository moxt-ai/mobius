import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdateV2, SessionEventPayloadV2, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpSessionEventStoreV2 } from "./session-event-store-v2.ts";

/**
 * Captures ACP load replay into the V2 session event log without turning
 * historical updates into live turns.
 */
export class AcpHistoryReplay {
    readonly #events: AcpSessionEventStoreV2;
    readonly #sessionId: string;

    constructor(events: AcpSessionEventStoreV2, sessionId: string) {
        this.#events = events;
        this.#sessionId = sessionId;
    }

    readonly record = async (
        _update: SessionNotification["update"],
        rawUpdate: AcpSessionUpdateV2,
        onRecorded: (event: SessionLiveEventV2) => Promise<void> = () => Promise.resolve(),
    ): Promise<void> => {
        const event = this.#events.append(this.#sessionId, { payload: rawUpdate, type: "acp" });
        await onRecorded(event);
    };

    readonly recordLifecycle = (event: SessionEventPayloadV2): SessionLiveEventV2 => {
        if (event.type !== "lifecycle-metadata") {
            throw new Error("Lifecycle history only accepts lifecycle metadata");
        }
        return this.#events.append(this.#sessionId, event);
    };

    readonly eventPage = (
        eventLimit: number,
        cursor: string | null,
    ): import("./session-contracts.ts").AcpNativeEventReplayV2 =>
        this.#events.page(this.#sessionId, eventLimit, cursor);
}
