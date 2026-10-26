import { methods } from "@agentclientprotocol/sdk";
import {
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_INFO_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
    type SessionEventPayload,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import {
    initializeAgentConnection,
    RetryableAcpInitializationError,
    validateAgentRuntime,
} from "../../acp/adapter/agent-initialization.ts";
import type { AdapterSessionConnection, AdapterSessionEvent } from "../../acp/adapter/session-events.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { validatePromptContent } from "../../acp/client/prompt-content.ts";
import type { Adapter, AdapterSessionTarget } from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import {
    restrictAcpSessionCapabilities,
    unsupportedSessionCapabilities,
} from "../../acp/protocol/session-capabilities.ts";
import {
    type SessionConfigProtocol,
    type SessionConfigurationSelection,
    sessionConfigProtocolForAgent,
} from "../../acp/protocol/session-config-protocol.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import { arraysEqual, recordsEqual, truncate } from "../../util/value-utils.ts";
import {
    type ElicitationResponseOptions,
    type PermissionResponseOptions,
    PreparedSession,
    type PromptResult,
    type SessionConfigureOptions,
    type SessionObserver,
    type SessionPrepareOptions,
    type SessionRecovery,
    type SessionSteerOptions,
    type SessionTurnOptions,
} from "../api/session-api.ts";
import type { SessionEventPage } from "../history/session-event-store.ts";
import { HistoryReplayCapture } from "../history/session-history.ts";
import { SessionInteractions } from "../interaction/session-interactions.ts";
import { waitForSharedOperation } from "../manager/operation-drain.ts";
import { type SessionStore, StoredSession } from "../record/session-store.ts";
import type { AgentSessionRestore } from "./agent-session-restore.ts";
import { type AgentTurnState, IdleAgentTurn, RunningAgentTurn } from "./agent-turn.ts";
import { SessionConfigurations } from "./session-configurations.ts";
import { restoreSession } from "./session-restore.ts";

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp/acp-error.ts";

type SessionLoadState =
    | { readonly kind: "not-requested" }
    | {
          readonly completion: Promise<LoadedSession>;
          readonly history: HistoryReplayCapture;
          readonly kind: "capturing";
      }
    | {
          readonly history: HistoryReplayCapture;
          readonly kind: "execution-only";
      }
    | LoadedSession;

type NativeHistoryOwnership =
    | { readonly kind: "unbound" }
    | { readonly kind: "fresh-session" }
    | { readonly kind: "agent-owned" };

interface LoadedSession {
    readonly history: HistoryReplayCapture;
    readonly kind: "loaded";
    readonly response: unknown;
}

export class AgentSession implements AgentSessionRestore {
    // The restore surface: AgentSessionRestore members expose private state to
    // session-restore.ts only. The class keeps the fields private.
    get additionalDirectories(): readonly string[] {
        return this.#additionalDirectories;
    }
    get agentId(): string {
        return this.#agentId;
    }
    get capabilities(): SessionCapabilities {
        return this.#capabilities;
    }
    get cwd(): string {
        return this.#cwd;
    }
    get metrics(): OperationMetrics {
        return this.#metrics;
    }
    get restored(): boolean {
        return this.#restored;
    }
    get sessionId(): string {
        return this.#mobiusSessionId;
    }
    get sessionConfigProtocol(): SessionConfigProtocol {
        return this.#sessionConfigProtocol;
    }
    get store(): SessionStore {
        return this.#store;
    }

    readonly hasBackgroundActivity = (): boolean => this.#connection.hasBackgroundActivity();
    readonly #connection: AdapterSessionConnection;
    readonly #adapter: Adapter;
    readonly #additionalDirectories: readonly string[];
    readonly #agentId: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => SessionObserver;
    readonly #interactions: SessionInteractions;
    #mobiusSessionId: string;
    readonly #updates: AdapterSessionConnection["events"];
    readonly #metrics: OperationMetrics;
    readonly #sessionConfigProtocol: SessionConfigProtocol;
    readonly #store: SessionStore;
    readonly #verifiedAgentVersion: string;
    #agentName = "";
    #agentVersion = "";
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    #configRevision = 0;
    #configOptions: readonly SessionConfigOption[] = [];
    readonly #sessionConfigurations = new SessionConfigurations();
    #nativeHistoryOwnership: NativeHistoryOwnership = { kind: "unbound" };
    #prompted = false;
    #sessionLoad: SessionLoadState = { kind: "not-requested" };
    #restored = false;
    #sessionTitle: string | null = null;
    #sessionUpdatedAt = "";
    #turn: AgentTurnState = new IdleAgentTurn();

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        additionalDirectories: readonly string[],
        mobiusSessionId: string,
        getObserver: () => SessionObserver,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
    ) {
        this.#additionalDirectories = [...additionalDirectories];
        this.#adapter = adapter;
        this.#agentId = agent.id;
        this.#commands = [];
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#mobiusSessionId = mobiusSessionId;
        this.#metrics = metrics;
        this.#sessionConfigProtocol = sessionConfigProtocolForAgent(agent.id);
        this.#store = store;
        this.#verifiedAgentVersion = agent.agentVersion;
        this.#getObserver = getObserver;
        this.#interactions = new SessionInteractions({
            cwd: () => this.#cwd,
            getToolCall: (toolCallId) => this.#store.events.getToolCall(this.#mobiusSessionId, toolCallId),
            sessionId: () => this.#mobiusSessionId,
            commandId: () => this.#turn.commandId,
            assertNativeSession: this.assertNativeSession,
            observer: getObserver,
            recordSessionEvent: this.recordLifecycleEvent,
        });
        const scope = {
            agent,
            cwd,
            sessionId: () => this.#mobiusSessionId,
            configOptions: () => this.#configOptions,
            onEvent: this.#processEvent,
        };
        this.#connection = this.#adapter.connectSession({
            ...scope,
            additionalDirectories: this.#additionalDirectories,
            capabilities: () => this.#capabilities,
            onBackgroundActivity: (active) => this.#getObserver().onBackgroundActivity?.(this, active),
            interactions: {
                onPermission: this.#interactions.onPermission,
                onElicitation: this.#interactions.onElicitation,
                onElicitationComplete: this.#interactions.onElicitationComplete,
            },
        });
        this.#updates = this.#connection.events;
    }

    static async #start(
        options: SessionPrepareOptions,
        getObserver: () => SessionObserver,
        store: SessionStore,
        initialize: (runtime: AgentSession) => Promise<void>,
        metrics: OperationMetrics,
        adapter: Adapter,
    ): Promise<AgentSession> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await metrics.measure(
                "executable-validation",
                async () => await validateAgentRuntime(options.agent, options.signal),
            );
            const runtime = metrics.measureSync(
                "process-spawn",
                () =>
                    new AgentSession(
                        options.agent,
                        options.cwd,
                        options.additionalDirectories,
                        options.sessionId,
                        getObserver,
                        store,
                        metrics,
                        adapter,
                    ),
            );
            try {
                await initialize(runtime);
                return runtime;
            } catch (error) {
                await runtime.closeProcess();
                options.signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${options.agent.id}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", {
                    cause: error,
                });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    }

    static readonly start = async (
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        getObserver: () => SessionObserver,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.initialize(options.signal, recovery, options.origin),
            metrics,
            adapter,
        );

    readonly belongsTo = (agentId: string, cwd: string, additionalDirectories: readonly string[]): boolean =>
        this.#agentId === agentId &&
        this.#cwd === cwd &&
        arraysEqual(this.#additionalDirectories, additionalDirectories);

    readonly usesEnvironment = (environment: Readonly<Record<string, string>>): boolean =>
        recordsEqual(this.#environment, environment);

    readonly canRebind = (): boolean => !this.#prompted && !this.#turn.running;

    readonly hasRunningTurn = (): boolean => this.#turn.running;

    readonly writeStoredSession = (updatedAt: string): void => {
        this.#store.write(
            new StoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#updates.sessionId(),
                this.#cwd,
                this.#additionalDirectories,
                this.#prompted,
                this.#sessionTitle ?? "",
                updatedAt,
                this.#sessionConfigurations.stored(),
            ),
        );
    };

    /**
     * Applies a client-requested title change. Agents that advertise the
     * `_session/rename` extension receive the new title first so their own
     * session state follows; the daemon then records the rename in the Session
     * event log as an ACP `session_info_update` so every projection and recorded
     * directory observes the same title transition.
     */
    readonly renameSession = async (
        title: string,
        signal: AbortSignal,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> => {
        const normalized = truncate(title, 500);
        if (normalized.length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        const nativeSessionId = this.#updates.sessionId();
        if (nativeSessionId.length > 0) {
            await this.#adapter.renameSession(this.#target(), normalized, signal);
        }
        const updatedAt = new Date().toISOString();
        await this.#processEvent({
            kind: "info",
            changes: [
                { kind: "title", value: normalized },
                { kind: "updated-at", value: updatedAt },
            ],
            payload: { sessionUpdate: "session_info_update", title: normalized, updatedAt },
        });
        return { title: this.#sessionTitle ?? normalized, updatedAt };
    };

    readonly #captureSelectedConfigurationValues = (): void => {
        this.#sessionConfigurations.capture(this.#configOptions);
        if (this.#updates.sessionId().length > 0) {
            this.writeStoredSession(new Date().toISOString());
        }
    };

    readonly restoreStoredConfigurations = async (session: StoredSession, signal: AbortSignal): Promise<void> => {
        await this.#sessionConfigurations.restore(
            session.configurations,
            this.#configOptions,
            this.#applyConfiguration,
            signal,
        );
    };

    readonly restrictSessionCapabilities = (response: unknown): void => {
        this.#capabilities = restrictAcpSessionCapabilities(this.#capabilities, response);
    };

    readonly prepared = (): PreparedSession =>
        new PreparedSession(
            this.#agentName,
            this.#agentVersion,
            this.#capabilities,
            this.#commands,
            this.#configOptions,
            this.#prompted,
            this.#restored,
        );

    readonly ensureHistoryLoaded = async (signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        await this.#completedHistory(signal, "ACP agent exited while loading history");
    };

    /** Starts live event capture without asking the native Agent to replay its persisted history. */
    readonly startExecutionOnlyCapture = (): void => {
        if (this.#sessionLoad.kind !== "not-requested") {
            return;
        }
        this.#sessionLoad = {
            history: new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId),
            kind: "execution-only",
        };
    };

    readonly loadHistoryEvents = async (
        eventLimit: number,
        cursor: string | null,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        const history = await this.#completedHistory(signal, "ACP agent exited while loading history");
        return history.eventPage(eventLimit, cursor);
    };

    async #completedHistory(signal: AbortSignal, exitMessage: string): Promise<HistoryReplayCapture> {
        if (!this.#prompted && this.#nativeHistoryOwnership.kind === "fresh-session") {
            if (this.#sessionLoad.kind === "not-requested") {
                this.#store.events.reset(this.#mobiusSessionId);
                this.#sessionLoad = {
                    history: new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId),
                    kind: "loaded",
                    response: {},
                };
            }
            if (this.#sessionLoad.kind === "loaded") {
                return this.#sessionLoad.history;
            }
        }
        return (await this.#loadSession(signal, exitMessage)).history;
    }

    async #loadSession(signal: AbortSignal, exitMessage: string): Promise<LoadedSession> {
        if (this.#sessionLoad.kind === "loaded") {
            return this.#sessionLoad;
        }
        if (this.#sessionLoad.kind === "capturing") {
            return await waitForSharedOperation(this.#sessionLoad.completion, signal);
        }
        this.#store.events.reset(this.#mobiusSessionId);
        const history = new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId);
        const completion = Promise.resolve().then(async (): Promise<LoadedSession> => {
            try {
                const response = await this.race(
                    this.#connection.connection.agent.request(
                        methods.agent.session.load,
                        {
                            additionalDirectories: [...this.#additionalDirectories],
                            cwd: this.#cwd,
                            mcpServers: [],
                            sessionId: this.#updates.sessionId(),
                        },
                        { cancellationSignal: signal },
                    ),
                    exitMessage,
                    signal,
                );
                await this.#updates.drained();
                signal.throwIfAborted();
                this.restrictSessionCapabilities(response);
                const loaded = { history, kind: "loaded", response } satisfies LoadedSession;
                this.#sessionLoad = loaded;
                return loaded;
            } catch (cause) {
                this.#sessionLoad = { kind: "not-requested" };
                throw cause;
            }
        });
        this.#sessionLoad = { completion, history, kind: "capturing" };
        return await completion;
    }

    async #initializeAgent(signal: AbortSignal): Promise<void> {
        await this.#metrics.measure("agent-initialize", async () => await this.#initializeAgentOperation(signal));
    }

    async #initializeAgentOperation(signal: AbortSignal): Promise<void> {
        const initialized = await initializeAgentConnection(
            this.#connection,
            this.#agentId,
            this.#verifiedAgentVersion,
            signal,
        );
        this.#capabilities = initialized.capabilities;
        this.#agentName = initialized.agentName;
        this.#agentVersion = initialized.agentVersion;
    }

    readonly initialize = async (
        signal: AbortSignal,
        recovery: SessionRecovery,
        origin?: NativeSessionOrigin,
    ): Promise<void> => await restoreSession(this, signal, recovery, origin);

    readonly nativeSessionId = (): string => this.#updates.sessionId();

    readonly adoptNativeSessionId = (sessionId: string): void => {
        if (this.#prompted || this.#updates.sessionId() !== sessionId) {
            throw new AcpExecutionError("The new native Session cannot be adopted", {}, "session_identity_mismatch");
        }
        const previousSessionId = this.#mobiusSessionId;
        this.#store.write(
            new StoredSession(
                sessionId,
                this.#agentId,
                sessionId,
                this.#cwd,
                this.#additionalDirectories,
                false,
                "",
                new Date().toISOString(),
                this.#sessionConfigurations.stored(),
            ),
        );
        this.#store.remove(previousSessionId);
        this.#mobiusSessionId = sessionId;
    };

    readonly #applyConfiguration = async (
        selection: SessionConfigurationSelection,
        signal: AbortSignal,
    ): Promise<void> => {
        const configRevision = this.#configRevision;
        const configured = await this.#adapter.configureSession(this.#target(), selection, signal);
        if (this.#configRevision === configRevision) {
            this.#configOptions = configured;
        }
    };

    readonly configure = async (options: SessionConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        await this.#applyConfiguration(
            options.valueType === "boolean"
                ? { type: "boolean", configId: options.configId, booleanValue: options.booleanValue }
                : { type: "select", configId: options.configId, value: options.value },
            options.signal,
        );
        const applied = this.#configOptions.find((option) => option.id === options.configId);
        if (applied === undefined) {
            throw new AcpExecutionError("The requested ACP configuration option is unavailable");
        }
        this.#sessionConfigurations.select(applied);
        this.writeStoredSession(new Date().toISOString());
        return this.#configOptions;
    };

    readonly #target = (): AdapterSessionTarget => ({
        nativeSessionId: this.#updates.sessionId(),
        cwd: this.#cwd,
        additionalDirectories: this.#additionalDirectories,
    });

    readonly prompt = async (options: SessionTurnOptions): Promise<PromptResult> => {
        if (this.#turn.running) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        if (!this.#capabilities.loadSession && this.#sessionLoad.kind === "not-requested") {
            this.#sessionLoad = {
                kind: "loaded",
                history: new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId),
                response: {},
            };
        }
        if (this.#capabilities.loadSession && this.#sessionLoad.kind !== "execution-only") {
            await this.#completedHistory(options.signal, "ACP agent exited while loading history before a prompt");
        }
        validatePromptContent(options, this.#capabilities);
        if (this.#sessionTitle === null || this.#sessionTitle.length === 0) {
            this.#sessionTitle = truncate(options.prompt, 500);
        }
        this.#prompted = true;
        this.writeStoredSession(new Date().toISOString());
        const running = new RunningAgentTurn(options.commandId);
        this.#turn = running;
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        try {
            const result = await this.#adapter.prompt(this.#target(), options, options.signal);
            this.writeStoredSession(new Date().toISOString());
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: { commandId: options.commandId, kind: "prompt.completed", stopReason: result.stopReason },
                    type: "lifecycle-metadata",
                });
            }
            return result;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload:
                        options.cancellationRequested?.() === true
                            ? { commandId: options.commandId, kind: "prompt.completed", stopReason: "cancelled" }
                            : {
                                  attemptId: lifecycle.attemptId,
                                  code: failure.code,
                                  commandId: options.commandId,
                                  kind: "prompt.failed",
                                  message: truncate(failure.message, 500),
                              },
                    type: "lifecycle-metadata",
                });
            }
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw failure;
        } finally {
            this.#turn = new IdleAgentTurn();
        }
    };

    readonly steer = async (options: SessionSteerOptions): Promise<string> => {
        if (!this.#capabilities.steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        if (!this.#turn.running || this.#turn.commandId !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        validatePromptContent(options, this.#capabilities);
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        try {
            const outcome = await this.#adapter.steer(this.#target(), options, options.signal);
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: { commandId: options.commandId, kind: "prompt.completed", stopReason: "steered" },
                    type: "lifecycle-metadata",
                });
            }
            return outcome;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        attemptId: lifecycle.attemptId,
                        code: failure.code,
                        commandId: options.commandId,
                        kind: "prompt.failed",
                        message: truncate(failure.message, 500),
                    },
                    type: "lifecycle-metadata",
                });
            }
            throw failure;
        }
    };

    readonly cancel = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.#interactions.cancelPendingInteractions();
        signal.throwIfAborted();
        if (this.#turn.running) {
            await this.#adapter.cancel(this.#target(), signal);
        }
    };

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        await this.#interactions.respondPermission(options);
    };
    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        await this.#interactions.respondElicitation(options);
    };

    readonly recordControlEvent = async (event: SessionEventPayload): Promise<boolean> => {
        if (this.#sessionLoad.kind !== "loaded" && this.#sessionLoad.kind !== "execution-only") {
            return false;
        }
        await this.recordLifecycleEvent(event);
        return true;
    };

    readonly recordLifecycleEvent = async (event: SessionEventPayload): Promise<void> => {
        if (
            event.type !== "lifecycle-metadata" ||
            (this.#sessionLoad.kind !== "loaded" && this.#sessionLoad.kind !== "execution-only")
        ) {
            return;
        }
        const liveEvent = this.#sessionLoad.history.recordLifecycle(event);
        await this.#getObserver().onSessionEvent?.(liveEvent);
    };

    readonly selectNativeSession = (sessionId: string): void => {
        this.#updates.select(sessionId);
        this.#nativeHistoryOwnership = { kind: "agent-owned" };
    };

    readonly #processEvent = async (event: AdapterSessionEvent): Promise<void> => {
        if (this.#sessionLoad.kind === "capturing") {
            await this.#sessionLoad.history.record(event.payload);
        } else if (this.#sessionLoad.kind === "loaded" || this.#sessionLoad.kind === "execution-only") {
            await this.#sessionLoad.history.record(event.payload, async (liveEvent) => {
                await this.#getObserver().onSessionEvent?.(liveEvent);
            });
        }
        switch (event.kind) {
            case "content":
            case "other":
                return;
            case "commands":
                this.#commands = event.commands;
                await this.#getObserver().onCommands({
                    commands: this.#commands,
                    kind: SESSION_COMMANDS_UPDATED_KIND,
                    sessionId: this.#mobiusSessionId,
                });
                return;
            case "configuration":
                this.#configOptions = event.configOptions;
                this.#configRevision += 1;
                this.#captureSelectedConfigurationValues();
                await this.emitConfigUpdate();
                return;
            case "mode":
                this.#configOptions = this.#configOptions.map((option) =>
                    option.category === "mode" ? { ...option, currentValue: event.modeId } : option,
                );
                this.#configRevision += 1;
                this.#captureSelectedConfigurationValues();
                await this.emitConfigUpdate();
                return;
            case "info":
                for (const change of event.changes) {
                    switch (change.kind) {
                        case "title":
                            this.#sessionTitle = change.value;
                            break;
                        case "updated-at":
                            this.#sessionUpdatedAt = change.value;
                            break;
                    }
                }
                if (this.#updates.sessionId().length > 0) {
                    this.writeStoredSession(new Date().toISOString());
                }
                await this.#getObserver().onInfo({
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId: this.#mobiusSessionId,
                    title: this.#sessionTitle,
                    updatedAt: this.#sessionUpdatedAt,
                });
                return;
        }
    };

    readonly close = async (): Promise<void> => {
        try {
            await this.#interactions.cancelPendingInteractions();
        } catch (error) {
            try {
                throw error;
            } finally {
                await this.closeProcess();
            }
        }
        if (this.#updates.sessionId().length === 0) {
            await this.closeProcess();
            return;
        }
        await this.#adapter.closeSession(this.#target(), AbortSignal.timeout(30_000));
    };

    readonly closeProcess = (): Promise<void> => this.#connection.closeProcess();

    readonly agentSettingsModelEffort = () => this.#connection.agentSettingsModelEffort();
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        this.#connection.race(operation, exitMessage, signal);

    agentRequest<Params, Result>(
        method: string,
        params: Params,
        options?: { cancellationSignal?: AbortSignal },
    ): Promise<Result> {
        return this.#connection.connection.agent.request(
            method as never,
            params as never,
            options as never,
        ) as Promise<Result>;
    }

    drained(): Promise<void> {
        return this.#updates.drained();
    }

    initializeAgent(signal: AbortSignal): Promise<void> {
        return this.#initializeAgent(signal);
    }

    async loadSession(signal: AbortSignal, exitMessage: string): Promise<{ response: unknown }> {
        return await this.#loadSession(signal, exitMessage);
    }

    setConfigOptions(options: readonly SessionConfigOption[]): void {
        this.#configOptions = options;
    }

    setNativeHistoryOwnership(ownership: NativeHistoryOwnership): void {
        this.#nativeHistoryOwnership = ownership;
    }

    setPrompted(prompted: boolean): void {
        this.#prompted = prompted;
    }

    setRestored(restored: boolean): void {
        this.#restored = restored;
    }

    setSessionTitle(title: string): void {
        this.#sessionTitle = title;
    }

    readonly assertNativeSession = (sessionId: string): void => {
        if (sessionId !== this.#updates.sessionId()) {
            throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
        }
    };

    readonly emitConfigUpdate = async (): Promise<void> => {
        await this.#getObserver().onConfig({
            configOptions: this.#configOptions,
            kind: SESSION_CONFIG_UPDATED_KIND,
            requestId: `agent-update-${crypto.randomUUID()}`,
            sessionId: this.#mobiusSessionId,
        });
    };
}
