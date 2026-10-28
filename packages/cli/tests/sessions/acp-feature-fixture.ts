import { fileURLToPath } from "node:url";

import type {
    AcpSessionUpdate,
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
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type { SessionObserver } from "../../src/engine/session/api/session-api.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";

export const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

/** Folds the live session event stream into the shapes integration tests assert on. */
export class RecordingObserver implements SessionObserver {
    readonly commands: SessionCommandsUpdatedEvent[] = [];
    readonly config: SessionConfigUpdatedEvent[] = [];
    readonly elicitations: SessionElicitationRequestedEvent[] = [];
    readonly information: SessionInfoUpdatedEvent[] = [];
    readonly permissions: SessionPermissionRequestedEvent[] = [];
    readonly permissionResolutions: SessionPermissionResolvedEvent[] = [];
    readonly elicitationResolutions: SessionElicitationResolvedEvent[] = [];
    readonly events: { readonly event: SessionEventPayload; readonly position: number }[] = [];
    readonly permissionArrived = Promise.withResolvers<SessionPermissionRequestedEvent>();
    readonly elicitationArrived = Promise.withResolvers<SessionElicitationRequestedEvent>();
    readonly #eventWaiters: Array<(event: SessionEventPayload) => void> = [];

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.commands.push(event);
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.config.push(event);
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
        for (const resolve of this.#eventWaiters.splice(0)) {
            resolve(event);
        }
        return Promise.resolve();
    };

    /** Resolves on the next recorded session event, without polling or timing. */
    readonly nextEvent = (): Promise<SessionEventPayload> =>
        new Promise((resolve) => {
            this.#eventWaiters.push(resolve);
        });

    /** Resolves when a recorded event satisfies the predicate, checking history first. */
    readonly waitForEvent = async (predicate: (event: SessionEventPayload) => boolean): Promise<void> => {
        for (;;) {
            if (this.events.some(({ event }) => predicate(event))) {
                return;
            }
            await this.nextEvent();
        }
    };

    /** Resolves on the first recorded ACP update of a turn. */
    readonly turnStarted = (): Promise<void> => this.waitForEvent((event) => event.type === "acp");

    /** Concatenated agent reply text, folded from the same events clients read.
     * Commentary-phase progress chunks are excluded, matching the answer text
     * consumers render rather than the transient progress indicator. */
    readonly agentText = (): string =>
        this.acpUpdates()
            .flatMap((update) => {
                if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
                    return [];
                }
                // The controlled peer marks commentary with a progress message id.
                return update.messageId?.startsWith("progress-") ? [] : [update.content.text];
            })
            .join("");

    /** Recorded ACP updates in arrival order, from the same events clients read. */
    readonly acpUpdates = (): readonly AcpSessionUpdate[] =>
        this.events.flatMap(({ event }) => (event.type === "acp" ? [event.payload] : []));

    /** Recorded tool-call updates for the given tool call id, in arrival order. */
    readonly toolUpdates = (toolCallId: string): readonly AcpSessionUpdate[] =>
        this.acpUpdates().filter(
            (update): update is Extract<AcpSessionUpdate, { readonly toolCallId: string }> =>
                (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                update.toolCallId === toolCallId,
        );
}

export function fakeAgent(
    additionalArguments: readonly string[] = [],
    environment: Readonly<Record<string, string>> = {},
    id = "codex",
): AcpAgentDefinition {
    return new AcpAgentDefinition(
        id,
        "Codex",
        process.execPath,
        (options) =>
            new ControlledAcpConnection(
                {
                    id,
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Codex", ...additionalArguments],
                    environment: options.environment,
                },
                options,
            ),
        environment,
    );
}
