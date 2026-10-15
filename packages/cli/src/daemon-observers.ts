import type {
    AgentContentEvent,
    RecordedSessionEvent,
    SessionCommandsUpdatedEvent,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionInfoUpdatedEvent,
    SessionLiveEventV2,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
    SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import type { AcpSessionObserver } from "./acp/agent-runtime-manager.ts";

export class DaemonAcpObserver implements AcpSessionObserver {
    readonly #record: (sessionId: string, event: RecordedSessionEvent) => void;
    readonly #recordV2: (event: SessionLiveEventV2) => void;

    constructor(
        record: (sessionId: string, event: RecordedSessionEvent) => void,
        recordV2: (event: SessionLiveEventV2) => void = () => undefined,
    ) {
        this.#record = record;
        this.#recordV2 = recordV2;
    }

    readonly onSessionEventV2 = (event: SessionLiveEventV2): Promise<void> => {
        this.#recordV2(event);
        return Promise.resolve();
    };

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onElicitation = (event: SessionElicitationRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onElicitationResolved = (event: SessionElicitationResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onPermission = (event: SessionPermissionRequestedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onPermissionResolved = (event: SessionPermissionResolvedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };

    readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
        this.#record(event.sessionId, event);
        return Promise.resolve();
    };
}
