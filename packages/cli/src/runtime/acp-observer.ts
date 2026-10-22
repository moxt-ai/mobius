import type { SessionInfoUpdatedEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import { NullSessionObserver } from "../session/api/session-api.ts";

export class RuntimeAcpObserver extends NullSessionObserver {
    readonly #publishInfo: (event: SessionInfoUpdatedEvent) => void;
    readonly #record: (event: SessionLiveEvent) => void;

    constructor(record: (event: SessionLiveEvent) => void, publishInfo: (event: SessionInfoUpdatedEvent) => void) {
        super();
        this.#publishInfo = publishInfo;
        this.#record = record;
    }

    override readonly onSessionEvent = (event: SessionLiveEvent): Promise<void> => {
        this.#record(event);
        return Promise.resolve();
    };

    override readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#publishInfo(event);
        return Promise.resolve();
    };
}
