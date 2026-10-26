import { setImmediate as yieldToRuntime } from "node:timers/promises";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
    type AcpSessionUpdate,
    decodeAcpSessionUpdate,
    type SessionCommand,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk/protocol";
import { truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import { AgentConnection } from "../connection/agent-connection.ts";
import { AgentUpdateStream } from "../connection/agent-update-stream.ts";
import type { AcpClientHandler } from "../connection/create-client.ts";
import type { AcpContentExternalizer } from "../content/content-externalizer.ts";
import { sessionConfigProtocolForAgent } from "../protocol/session-config-protocol.ts";

type SessionInfoChange =
    | { readonly kind: "title"; readonly value: string }
    | { readonly kind: "updated-at"; readonly value: string };

/** Normalized adapter output. Session persistence and client publication remain with the consumer. */
export type AdapterSessionEvent =
    | { readonly kind: "content" | "other"; readonly payload: AcpSessionUpdate }
    | { readonly kind: "commands"; readonly commands: readonly SessionCommand[]; readonly payload: AcpSessionUpdate }
    | {
          readonly kind: "configuration";
          readonly configOptions: readonly SessionConfigOption[];
          readonly payload: AcpSessionUpdate;
      }
    | { readonly kind: "mode"; readonly modeId: string; readonly payload: AcpSessionUpdate }
    | { readonly kind: "info"; readonly changes: readonly SessionInfoChange[]; readonly payload: AcpSessionUpdate };

interface SessionConnectionScope {
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: () => string;
    readonly configOptions: () => readonly SessionConfigOption[];
    readonly onEvent: (event: AdapterSessionEvent) => Promise<void>;
}

export interface AdapterSessionConnectionOptions extends SessionConnectionScope {
    readonly interactions: Pick<AcpClientHandler, "onPermission" | "onElicitation" | "onElicitationComplete">;
}

/** Internal execution port shared by the live session and adapter-owned history capture. */
export interface AdapterSessionConnector {
    readonly connectSession: (options: AdapterSessionConnectionOptions) => AdapterSessionConnection;
}

/** ACP subscription lifetime, ordered delivery and harness normalization belong to the adapter. */
export class AdapterSessionConnection {
    readonly #connection: AgentConnection;
    readonly #updates: AgentUpdateStream;
    readonly #lifetime = new AbortController();
    readonly events: Pick<AgentUpdateStream, "sessionId" | "select" | "drained">;

    constructor(options: AdapterSessionConnectionOptions, externalizer: AcpContentExternalizer) {
        const protocol = sessionConfigProtocolForAgent(options.agent.id);
        this.#updates = new AgentUpdateStream(async (notification: SessionNotification) => {
            this.#lifetime.signal.throwIfAborted();
            if (notification.sessionId !== this.#updates.sessionId()) {
                throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
            }
            const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]);
            const externalized = await externalizer.update(options.sessionId(), notification.update, signal);
            signal.throwIfAborted();
            const update = externalized.agent;
            const payload = decodeAcpSessionUpdate(JSON.stringify(externalized.event));
            let event: AdapterSessionEvent;
            switch (update.sessionUpdate) {
                case "available_commands_update":
                    event = {
                        kind: "commands",
                        payload,
                        commands: update.availableCommands
                            .slice(0, 500)
                            .map((command) => ({
                                description: truncate(command.description, 500),
                                inputHint: truncate(command.input?.hint ?? "", 255),
                                name: truncate(command.name, 128),
                            }))
                            .filter((command) => command.name.length > 0),
                    };
                    break;
                case "config_option_update":
                    event = {
                        kind: "configuration",
                        payload,
                        configOptions: protocol.normalizeUpdate(options.configOptions(), update.configOptions),
                    };
                    break;
                case "current_mode_update":
                    event = { kind: "mode", payload, modeId: update.currentModeId };
                    break;
                case "session_info_update": {
                    const changes: SessionInfoChange[] = [];
                    if (Object.hasOwn(update, "title")) {
                        changes.push({ kind: "title", value: truncate(update.title ?? "", 500) });
                    }
                    if (Object.hasOwn(update, "updatedAt")) {
                        changes.push({ kind: "updated-at", value: truncate(update.updatedAt ?? "", 128) });
                    }
                    event = { kind: "info", payload, changes };
                    break;
                }
                case "user_message_chunk":
                case "agent_message_chunk":
                case "agent_thought_chunk":
                case "tool_call":
                case "tool_call_update":
                case "plan":
                case "plan_update":
                case "plan_removed":
                    event = { kind: "content", payload };
                    break;
                default:
                    event = { kind: "other", payload };
            }
            await options.onEvent(event);
        });
        this.events = this.#updates;
        const client: AcpClientHandler = {
            onUpdate: async (notification) => {
                if (this.#lifetime.signal.aborted) {
                    return;
                }
                try {
                    await this.#updates.receive(notification);
                } catch (error) {
                    // Closing this subscription cancels delivery, not the harness's
                    // background notification producer. Observe our own cancellation
                    // here; operational failures still reach the caller and drain.
                    if (this.#lifetime.signal.aborted && error === this.#lifetime.signal.reason) {
                        return;
                    }
                    throw error;
                }
            },
            onPermission: async (request, signal) => {
                // ACP dispatches requests concurrently. Apply preceding tool updates before describing the permission.
                await yieldToRuntime(undefined, { signal });
                await this.#updates.drained();
                signal.throwIfAborted();
                return await options.interactions.onPermission(request, signal);
            },
            onElicitation: options.interactions.onElicitation,
            onElicitationComplete: options.interactions.onElicitationComplete,
        };
        this.#connection = new AgentConnection(options.agent, options.cwd, client);
    }

    get connection() {
        return this.#connection.connection;
    }
    get inProcessAgent() {
        return this.#connection.inProcessAgent;
    }
    readonly agentSettingsModelEffort = () => this.#connection.inProcessAgent?.agentSettingsModelEffort?.() ?? null;
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        this.#connection.race(operation, exitMessage, signal);

    readonly closeProcess = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The adapter event subscription closed", "AbortError"));
        try {
            await this.#connection.closeProcess();
        } finally {
            // Every queued delivery is observed before releasing this subscription.
            await this.#updates.drained().catch(() => undefined);
        }
    };
}

/** Reusable ACP transport implementation; each harness adapter owns its connector. */
export class AcpSessionConnector implements AdapterSessionConnector {
    readonly #externalizer: AcpContentExternalizer;
    constructor(externalizer: AcpContentExternalizer) {
        this.#externalizer = externalizer;
    }
    readonly connectSession = (options: AdapterSessionConnectionOptions): AdapterSessionConnection =>
        new AdapterSessionConnection(options, this.#externalizer);

    readonly connectQuerySession = (options: SessionConnectionScope): AdapterSessionConnection => {
        const rejectInteraction = async (): Promise<never> => {
            throw new AcpExecutionError(
                "Read-only history previews cannot request user interaction",
                {},
                "native_session_interaction_unsupported",
            );
        };
        return new AdapterSessionConnection(
            {
                ...options,
                interactions: {
                    onPermission: rejectInteraction,
                    onElicitation: rejectInteraction,
                    onElicitationComplete: rejectInteraction,
                },
            },
            this.#externalizer,
        );
    };
}
