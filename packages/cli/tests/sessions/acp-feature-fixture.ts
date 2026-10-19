import { fileURLToPath } from "node:url";

import type {
    AgentContentEvent,
    SessionCommandsUpdatedEvent,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionEventPayload,
    SessionInfoUpdatedEvent,
    SessionLiveEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AcpSessionObserver } from "../../src/acp/agent-runtime-manager.ts";
import { LocalAgentDefinition } from "../../src/daemon/config.ts";

export const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

export class RecordingObserver implements AcpSessionObserver {
    readonly commands: SessionCommandsUpdatedEvent[] = [];
    readonly config: SessionConfigUpdatedEvent[] = [];
    readonly content: AgentContentEvent[] = [];
    readonly elicitations: SessionElicitationRequestedEvent[] = [];
    readonly information: SessionInfoUpdatedEvent[] = [];
    readonly permissions: SessionPermissionRequestedEvent[] = [];
    readonly permissionResolutions: SessionPermissionResolvedEvent[] = [];
    readonly elicitationResolutions: SessionElicitationResolvedEvent[] = [];
    readonly events: { readonly event: SessionEventPayload; readonly position: number }[] = [];
    readonly permissionArrived = Promise.withResolvers<SessionPermissionRequestedEvent>();
    readonly elicitationArrived = Promise.withResolvers<SessionElicitationRequestedEvent>();

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.commands.push(event);
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.config.push(event);
        return Promise.resolve();
    };

    readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.content.push(event);
        return Promise.resolve();
    };

    readonly onElicitation = (event: SessionElicitationRequestedEvent): Promise<void> => {
        this.elicitations.push(event);
        this.elicitationArrived.resolve(event);
        return Promise.resolve();
    };

    readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.information.push(event);
        return Promise.resolve();
    };

    readonly onPermission = (event: SessionPermissionRequestedEvent): Promise<void> => {
        this.permissions.push(event);
        this.permissionArrived.resolve(event);
        return Promise.resolve();
    };

    readonly onPermissionResolved = (event: SessionPermissionResolvedEvent): Promise<void> => {
        this.permissionResolutions.push(event);
        return Promise.resolve();
    };

    readonly onElicitationResolved = (event: SessionElicitationResolvedEvent): Promise<void> => {
        this.elicitationResolutions.push(event);
        return Promise.resolve();
    };

    readonly onSessionEvent = (liveEvent: SessionLiveEvent): Promise<void> => {
        const event: SessionEventPayload =
            liveEvent.type === "acp"
                ? { payload: liveEvent.payload, type: "acp" }
                : { payload: liveEvent.payload, type: "lifecycle-metadata" };
        this.events.push({
            event,
            position: Number(liveEvent.position),
        });
        return Promise.resolve();
    };
}

export function fakeAgent(
    additionalArguments: readonly string[] = [],
    environment: Readonly<Record<string, string>> = {},
    id = "codex",
): LocalAgentDefinition {
    return new LocalAgentDefinition(
        id,
        "Codex",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Codex", ...additionalArguments],
        environment,
    );
}
