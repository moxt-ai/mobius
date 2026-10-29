import { setImmediate as yieldToRuntime } from "node:timers/promises";
import {
    type AcpSessionUpdate,
    decodeAcpSessionUpdate,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk/protocol";
import { truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { BackgroundActivity } from "../agent/in-process-endpoint.ts";
import type { AgentConnection } from "../connection/agent-connection.ts";
import { AgentUpdateStream } from "../connection/agent-update-stream.ts";
import type { AcpClientHandler } from "../connection/create-client.ts";
import type { IdentifiedSessionNotification as SessionNotification } from "../connection/session-notification.ts";
import type { AcpContentExternalizer, ExternalizeSessionUpdate } from "../content/content-externalizer.ts";
import { restrictAcpSessionCapabilities } from "../protocol/session-capabilities.ts";
import { sessionConfigProtocolForAgent } from "../protocol/session-config-protocol.ts";
import { initializeAgentConnection } from "./agent-initialization.ts";
import {
    applyConfigurationChanges,
    applyConfigurationMode,
    type ConfigurationChanges,
    recordConfigurationMode,
    recordConfigurationOptions,
} from "./configuration-changes.ts";

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
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
    readonly onEvent: (event: AdapterSessionEvent) => Promise<void>;
}

export interface AdapterSessionConnectionOptions extends SessionConnectionScope {
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly interactions: Pick<AcpClientHandler, "onPermission" | "onElicitation" | "onElicitationComplete">;
}

export interface AdapterSessionSubscriber {
    readonly onSessionEvent: (nativeSessionId: string, event: AdapterSessionEvent) => Promise<void>;
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly interactions: AdapterSessionConnectionOptions["interactions"];
}

/** Internal execution port shared by the live session and adapter-owned history capture. */
export interface AdapterSessionConnector {
    readonly connectSession: (options: AdapterSessionConnectionOptions) => AdapterSessionConnection;
}

export interface AdapterSessionSnapshot {
    readonly capabilities: SessionCapabilities;
    readonly configOptions: readonly SessionConfigOption[];
}

type ConfigurationOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "pending"; readonly changes: ConfigurationChanges };
type ExecutionState =
    | { readonly kind: "uninitialized" }
    | {
          readonly kind: "ready";
          readonly snapshot: AdapterSessionSnapshot;
          readonly operation: ConfigurationOperation;
      }
    | { readonly kind: "closed" };

/** ACP subscription lifetime, ordered delivery and harness normalization belong to the adapter. */
export class AdapterSessionConnection {
    readonly #connection: AgentConnection;
    readonly #onBackgroundActivity: (activity: BackgroundActivity) => void;
    #backgroundActivity: BackgroundActivity = "none";
    readonly hasBackgroundActivity = (): boolean => this.#backgroundActivity !== "none";
    readonly #updates: AgentUpdateStream;
    readonly #lifetime = new AbortController();
    readonly #onClosed: () => void;
    readonly #agent: AcpAgentDefinition;
    #state: ExecutionState = { kind: "uninitialized" };
    #initialization:
        | { readonly kind: "not-started" }
        | { readonly kind: "started"; readonly result: ReturnType<typeof initializeAgentConnection> } = {
        kind: "not-started",
    };
    readonly events: Pick<AgentUpdateStream, "sessionId" | "select" | "drained">;

    constructor(
        options: AdapterSessionConnectionOptions,
        externalizer: Pick<AcpContentExternalizer, "update">,
        normalizeEvent: (event: unknown) => unknown,
        onClosed: () => void = () => undefined,
    ) {
        this.#agent = options.agent;
        this.#onClosed = onClosed;
        this.#onBackgroundActivity = options.onBackgroundActivity ?? (() => {});
        this.#updates = new AgentUpdateStream(async (notification: SessionNotification) => {
            this.#lifetime.signal.throwIfAborted();
            if (notification.sessionId !== this.#updates.sessionId()) {
                throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
            }
            const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]);
            const externalized =
                options.externalizeUpdate === undefined
                    ? await externalizer.update(notification.sessionId, notification.update, signal)
                    : await options.externalizeUpdate(notification.update, signal);
            signal.throwIfAborted();
            const update = externalized.agent;
            for (const eventUpdate of externalized.events) {
                const backgroundTask = update._meta?.["mobius.backgroundTask"];
                const payload = decodeAcpSessionUpdate(
                    JSON.stringify(
                        normalizeEvent(
                            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                                backgroundTask !== undefined &&
                                typeof eventUpdate === "object" &&
                                eventUpdate !== null
                                ? { ...eventUpdate, backgroundTask }
                                : eventUpdate,
                        ),
                    ),
                );
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
                        this.#applyConfigurationUpdate(update.configOptions);
                        event = {
                            kind: "configuration",
                            payload,
                            configOptions: this.snapshot().configOptions,
                        };
                        break;
                    case "current_mode_update":
                        this.#applyModeUpdate(update.currentModeId);
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
            }
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
        this.#connection = options.agent.createConnection({
            cwd: options.cwd,
            client,
            onBackgroundActivity: (activity) => {
                if (this.#lifetime.signal.aborted) {
                    return;
                }
                this.#backgroundActivity = activity;
                this.#onBackgroundActivity(activity);
            },
        });
    }

    get connection() {
        return this.#connection.connection;
    }
    get termination() {
        return this.#connection.termination;
    }

    readonly #ready = (): Extract<ExecutionState, { readonly kind: "ready" }> => {
        const state = this.#state;
        if (state.kind !== "ready") {
            throw new AcpExecutionError(
                "The Agent session is not initialized or has closed",
                {},
                "invalid_agent_session",
            );
        }
        return state;
    };

    readonly snapshot = (): AdapterSessionSnapshot => this.#ready().snapshot;

    readonly beginStateChange = (): void => {
        const state = this.#ready();
        if (state.operation.kind !== "idle") {
            throw new AcpExecutionError("Another session configuration operation is running", {}, "session_busy");
        }
        this.#state = { ...state, operation: { kind: "pending", changes: { kind: "unchanged" } } };
    };

    readonly cancelStateChange = (): void => {
        if (this.#state.kind === "ready") {
            this.#state = { ...this.#state, operation: { kind: "idle" } };
        }
    };

    readonly commitConfiguration = (options: readonly SessionConfigOption[]): readonly SessionConfigOption[] => {
        const state = this.#ready();
        if (state.operation.kind !== "pending") {
            throw new AcpExecutionError("No session configuration operation is running", {}, "invalid_agent_session");
        }
        const configOptions = applyConfigurationChanges(options, state.operation.changes);
        this.#state = { ...state, snapshot: { ...state.snapshot, configOptions }, operation: { kind: "idle" } };
        return configOptions;
    };

    readonly commitLifecycle = (response: unknown): AdapterSessionSnapshot => {
        const state = this.#ready();
        const capabilities = restrictAcpSessionCapabilities(state.snapshot.capabilities, response);
        this.commitConfiguration(sessionConfigProtocolForAgent(this.#agent.id).normalizeLifecycle(response));
        this.#state = { ...this.#ready(), snapshot: { capabilities, configOptions: this.snapshot().configOptions } };
        return this.snapshot();
    };

    readonly #applyConfigurationUpdate = (value: unknown): void => {
        const state = this.#ready();
        const protocol = sessionConfigProtocolForAgent(this.#agent.id);
        const configOptions = protocol.normalizeUpdate(state.snapshot.configOptions, value);
        const operation: ConfigurationOperation =
            state.operation.kind === "pending"
                ? {
                      kind: "pending",
                      changes: recordConfigurationOptions(state.operation.changes, protocol.normalizeUpdate([], value)),
                  }
                : state.operation;
        this.#state = { ...state, snapshot: { ...state.snapshot, configOptions }, operation };
    };

    readonly #applyModeUpdate = (modeId: string): void => {
        const state = this.#ready();
        const operation: ConfigurationOperation =
            state.operation.kind === "pending"
                ? { kind: "pending", changes: recordConfigurationMode(state.operation.changes, modeId) }
                : state.operation;
        this.#state = {
            ...state,
            snapshot: {
                ...state.snapshot,
                configOptions: applyConfigurationMode(state.snapshot.configOptions, modeId),
            },
            operation,
        };
    };
    readonly initialize = (signal: AbortSignal): Promise<void> => this.#connection.initialize(signal);
    readonly initializeAgent = (signal: AbortSignal) => {
        if (this.#initialization.kind === "not-started") {
            this.#initialization = {
                kind: "started",
                result: initializeAgentConnection(this, this.#agent.id, this.#agent.agentVersion, signal).then(
                    (agent) => {
                        this.#lifetime.signal.throwIfAborted();
                        this.#state = {
                            kind: "ready",
                            snapshot: { capabilities: agent.capabilities, configOptions: [] },
                            operation: { kind: "idle" },
                        };
                        return agent;
                    },
                ),
            };
        }
        return this.#initialization.result;
    };
    readonly agentSettingsModelEffort = () => this.#connection.agentSettingsModelEffort();
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        this.#connection.race(operation, exitMessage, signal);

    readonly closeProcess = async (): Promise<void> => {
        this.#state = { kind: "closed" };
        this.#lifetime.abort(new DOMException("The adapter event subscription closed", "AbortError"));
        try {
            await this.#connection.closeProcess();
        } finally {
            // Every queued delivery is observed before releasing this subscription.
            try {
                await this.#updates.drained().catch(() => undefined);
            } finally {
                this.#onClosed();
                this.#backgroundActivity = "none";
                this.#onBackgroundActivity("none");
            }
        }
    };
}

/** Reusable ACP transport implementation; each harness adapter owns its connector. */
export class AcpSessionConnector implements AdapterSessionConnector {
    readonly #externalizer: Pick<AcpContentExternalizer, "update">;
    readonly #normalizeEvent: (event: unknown) => unknown;
    constructor(
        externalizer: Pick<AcpContentExternalizer, "update">,
        normalizeEvent: (event: unknown) => unknown = (event) => event,
    ) {
        this.#externalizer = externalizer;
        this.#normalizeEvent = normalizeEvent;
    }
    readonly connectSession = (options: AdapterSessionConnectionOptions): AdapterSessionConnection =>
        new AdapterSessionConnection(options, this.#externalizer, this.#normalizeEvent);

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
            this.#normalizeEvent,
        );
    };
}
