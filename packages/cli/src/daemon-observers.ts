import {
    AGENT_INSTALL_CANCELLED_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_STARTED_KIND,
    type AgentContentEvent,
    type DaemonToServiceMessage,
    type RecordedSessionEvent,
    type SessionCommandsUpdatedEvent,
    type SessionConfigUpdatedEvent,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionLiveEventV2,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";
import type { AcpSessionObserver } from "./acp/agent-runtime-manager.ts";
import {
    type AgentInstallation,
    CancelledInstallation,
    FailedInstallation,
    type InstallationAudit,
    type InstallationObserver,
    RequestedInstallation,
    RunningInstallation,
    SucceededInstallation,
} from "./agent-installation/agent-installation-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { send } from "./daemon-command-results.ts";

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

export class AuditInstallationEvents implements InstallationAudit {
    readonly #audit: AuditStore;

    constructor(audit: AuditStore) {
        this.#audit = audit;
    }

    readonly record = (
        event: string,
        requestId: string,
        agentId: string,
        details: Readonly<Record<string, string>> = {},
    ): void => {
        this.#audit.record({
            commandId: requestId,
            details,
            event,
            sessionId: `agent-installation:${agentId}`,
        });
    };
}

export class DaemonInstallationObserver implements InstallationObserver {
    readonly #started = new Set<string>();
    #socket: WebSocket | null = null;

    readonly connect = (socket: WebSocket): void => {
        this.#socket = socket;
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#socket === socket) {
            this.#socket = null;
        }
    };

    readonly #send = (socket: WebSocket, message: DaemonToServiceMessage): void => {
        try {
            send(socket, message);
        } catch {
            if (this.#socket === socket) {
                this.#socket = null;
            }
        }
    };

    readonly onState = (state: AgentInstallation): Promise<void> => {
        const socket = this.#socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (state instanceof RequestedInstallation) {
            return Promise.resolve();
        }
        if (state instanceof RunningInstallation) {
            if (!this.#started.has(state.requestId)) {
                this.#started.add(state.requestId);
                this.#send(socket, {
                    agentId: state.agentId,
                    kind: AGENT_INSTALL_STARTED_KIND,
                    requestId: state.requestId,
                });
            }
            this.#send(socket, {
                agentId: state.agentId,
                kind: AGENT_INSTALL_PROGRESS_KIND,
                requestId: state.requestId,
                stage: state.stage,
            });
            return Promise.resolve();
        }
        if (state instanceof SucceededInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                authenticationMayBeRequired: state.authenticationMayBeRequired,
                kind: AGENT_INSTALL_COMPLETED_KIND,
                requestId: state.requestId,
            });
            return Promise.resolve();
        }
        if (state instanceof FailedInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                code: state.code,
                kind: AGENT_INSTALL_FAILED_KIND,
                message: state.message,
                requestId: state.requestId,
            });
            return Promise.resolve();
        }
        if (state instanceof CancelledInstallation) {
            this.#send(socket, {
                agentId: state.agentId,
                kind: AGENT_INSTALL_CANCELLED_KIND,
                requestId: state.requestId,
            });
            return Promise.resolve();
        }
        throw new Error("Unsupported Agent integration installation state");
    };
}
