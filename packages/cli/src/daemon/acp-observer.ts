import type { AgentContentEvent, SessionInfoUpdatedEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import { NullAcpSessionObserver } from "../acp/session-contracts.ts";

export class DaemonAcpObserver extends NullAcpSessionObserver {
    readonly #publishInfo: (event: SessionInfoUpdatedEvent) => void;
    readonly #recordContent: (event: AgentContentEvent) => void;
    readonly #record: (event: SessionLiveEvent) => void;

    constructor(
        record: (event: SessionLiveEvent) => void,
        recordContent: (event: AgentContentEvent) => void,
        publishInfo: (event: SessionInfoUpdatedEvent) => void,
    ) {
        super();
        this.#publishInfo = publishInfo;
        this.#recordContent = recordContent;
        this.#record = record;
    }

    override readonly onSessionEvent = (event: SessionLiveEvent): Promise<void> => {
        this.#record(event);
        return Promise.resolve();
    };

    override readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.#recordContent(event);
        return Promise.resolve();
    };

    override readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#publishInfo(event);
        return Promise.resolve();
    };
}
