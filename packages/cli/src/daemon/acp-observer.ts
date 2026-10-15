import type { AgentContentEvent, SessionInfoUpdatedEvent, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import { NullAcpSessionObserver } from "../acp/session-contracts.ts";

export class DaemonAcpObserver extends NullAcpSessionObserver {
    readonly #publishInfo: (event: SessionInfoUpdatedEvent) => void;
    readonly #record: (event: AgentContentEvent) => void;
    readonly #recordV2: (event: SessionLiveEventV2) => void;

    constructor(
        recordV2: (event: SessionLiveEventV2) => void,
        record: (event: AgentContentEvent) => void,
        publishInfo: (event: SessionInfoUpdatedEvent) => void,
    ) {
        super();
        this.#publishInfo = publishInfo;
        this.#record = record;
        this.#recordV2 = recordV2;
    }

    override readonly onSessionEventV2 = (event: SessionLiveEventV2): Promise<void> => {
        this.#recordV2(event);
        return Promise.resolve();
    };

    override readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.#record(event);
        return Promise.resolve();
    };

    override readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#publishInfo(event);
        return Promise.resolve();
    };
}
