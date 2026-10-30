import { conversationTitleFromText } from "@moxt-ai/mobius-sdk";
import type { SessionInteractionSnapshot } from "@moxt-ai/mobius-sdk/protocol";
import {
    type AgentModelEffort,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_INFO_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
    type SessionEventPayload,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { RetryableAcpInitializationError, validateAgentRuntime } from "../../acp/adapter/agent-initialization.ts";
import type { AdapterSessionEvent, AdapterSessionSubscriber } from "../../acp/adapter/session-events.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import { validatePromptContent } from "../../acp/client/prompt-content.ts";
import type {
    Adapter,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionScope,
    AdapterSessionTarget,
    NativeHistoryRevision,
} from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import type { SessionConfigurationSelection } from "../../acp/protocol/session-config-protocol.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import { SerialTaskQueue } from "../../util/serial-task-queue.ts";
import { arraysEqual, recordsEqual, truncate } from "../../util/value-utils.ts";
import {
    type ElicitationResponseOptions,
    type PermissionResponseOptions,
    PreparedSession,
    type PromptResult,
    type SessionConfigurationSnapshot,
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

/** The native conversation entry this process continues from, recorded after its own writes settle. */
type NativeHistoryBaseline =
    | { readonly kind: "unavailable" }
    | { readonly kind: "recording"; readonly completion: Promise<void> }
    | { readonly kind: "recorded"; readonly latestEntryId: string };

interface LoadedSession {
    readonly history: HistoryReplayCapture;
    readonly kind: "loaded";
    readonly opened: AdapterSessionOpened;
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
    get store(): SessionStore {
        return this.#store;
    }

    readonly hasBackgroundActivity = (): boolean => this.#backgroundActivity !== "none";
    #backgroundActivity: BackgroundActivity = "none";
    #modelEffort: AgentModelEffort | null = null;
    readonly #scope: AdapterSessionScope;
    readonly #subscriber: AdapterSessionSubscriber;
    #nativeIdentity: { readonly kind: "unbound" } | { readonly kind: "bound"; readonly nativeSessionId: string } = {
        kind: "unbound",
    };
    get #nativeSessionId(): string {
        return this.#nativeIdentity.kind === "bound" ? this.#nativeIdentity.nativeSessionId : "";
    }
    readonly #adapter: Adapter;
    readonly #additionalDirectories: readonly string[];
    readonly #agentId: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => SessionObserver;
    readonly #interactions: SessionInteractions;
    #mobiusSessionId: string;
    readonly #metrics: OperationMetrics;
    readonly #store: SessionStore;
    #agentName = "";
    #agentVersion = "";
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    #configRevision = crypto.randomUUID();
    readonly #configurationChanges = new SerialTaskQueue();
    #configOptions: readonly SessionConfigOption[] = [];
    readonly #sessionConfigurations = new SessionConfigurations();
    #nativeHistoryOwnership: NativeHistoryOwnership = { kind: "unbound" };
    #nativeHistoryBaseline: NativeHistoryBaseline = { kind: "unavailable" };
    #nativeHistoryWrites = 0;
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
        externalize: SessionPrepareOptions["externalizeSessionUpdate"],
    ) {
        this.#additionalDirectories = [...additionalDirectories];
        this.#adapter = adapter;
        this.#agentId = agent.id;
        this.#commands = [];
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#mobiusSessionId = mobiusSessionId;
        this.#metrics = metrics;
        this.#store = store;
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
        this.#scope = {
            agent,
            cwd,
            additionalDirectories: this.#additionalDirectories,
            ...(externalize === undefined
                ? {}
                : { externalizeUpdate: (update, signal) => externalize(this.#mobiusSessionId, update, signal) }),
        };
        this.#subscriber = {
            onSessionEvent: async (nativeSessionId, event) => {
                if (this.#nativeSessionId.length === 0) {
                    this.selectNativeSession(nativeSessionId);
                } else {
                    this.assertNativeSession(nativeSessionId);
                }
                await this.#processEvent(event);
            },
            onBackgroundActivity: (activity) => {
                const previous = this.#backgroundActivity;
                this.#backgroundActivity = activity;
                this.#getObserver().onBackgroundActivity?.(this, activity);
                if (previous !== "none" && activity === "none") {
                    // Background work may have appended to native history on this process's behalf.
                    void this.#recordNativeHistoryRevision();
                }
            },
            interactions: {
                onPermission: this.#interactions.onPermission,
                onElicitation: this.#interactions.onElicitation,
                onElicitationComplete: this.#interactions.onElicitationComplete,
            },
        };
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
                        options.externalizeSessionUpdate,
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
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => {
                runtime.#capabilities = capabilities;
                await runtime.initialize(options.signal, recovery, options.origin);
            },
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
                this.#nativeSessionId,
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
        const nativeSessionId = this.#nativeSessionId;
        if (nativeSessionId.length > 0) {
            await this.#writeNativeHistory(
                async () => await this.#adapter.renameSession({ ...this.#target(), title: normalized, signal }),
            );
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
        if (this.#nativeSessionId.length > 0) {
            this.writeStoredSession(new Date().toISOString());
        }
    };

    readonly restoreStoredConfigurations = async (
        session: StoredSession,
        signal: AbortSignal,
        intent: "restore" | "fork" = "restore",
    ): Promise<void> => {
        // A model can change the supported modes. Restore it before replaying
        // the source mode, regardless of the order in which the user edited them.
        const configurations =
            intent === "fork"
                ? session.configurations.toSorted(
                      (left, right) => Number(right.configId === "model") - Number(left.configId === "model"),
                  )
                : session.configurations;
        await this.#sessionConfigurations.restore(
            configurations,
            () => this.#configOptions,
            this.#applyConfiguration,
            signal,
        );
        if (intent === "fork") {
            for (const selection of session.configurations) {
                // Mode carries the Agent's execution/approval constraint. Keep the existing
                // best-effort behavior for model selections that disappear from a catalog.
                if (selection.configId !== "mode") {
                    continue;
                }
                const current = this.#configOptions.find((option) => option.id === selection.configId);
                if (
                    current?.type !== selection.type ||
                    (selection.type === "select"
                        ? current.currentValue !== selection.value
                        : current.booleanValue !== selection.booleanValue)
                ) {
                    throw new AcpExecutionError(
                        "The Agent could not preserve the source Session mode for this Fork",
                        {},
                        "invalid_session_configuration",
                    );
                }
            }
        }
    };

    readonly applySessionOpened = (opened: AdapterSessionOpened): void => {
        this.#agentName = opened.agentName;
        this.#agentVersion = opened.agentVersion;
        this.#modelEffort = opened.agentSettingsModelEffort;
        this.#capabilities = opened.capabilities;
        this.setConfigOptions(opened.configOptions);
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
            this.#configRevision,
        );

    readonly ensureHistoryLoaded = async (signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        await this.#completedHistory(signal);
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
        const history = await this.#completedHistory(signal);
        return history.eventPage(eventLimit, cursor);
    };

    async #completedHistory(signal: AbortSignal): Promise<HistoryReplayCapture> {
        if (!this.#prompted && this.#nativeHistoryOwnership.kind === "fresh-session") {
            if (this.#sessionLoad.kind === "not-requested") {
                this.#store.events.reset(this.#mobiusSessionId);
                this.#sessionLoad = {
                    history: new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId),
                    kind: "loaded",
                    opened: {
                        nativeSessionId: this.nativeSessionId(),
                        capabilities: this.#capabilities,
                        configOptions: [],
                        agentName: this.#agentName,
                        agentVersion: this.#agentVersion,
                        agentSettingsModelEffort: this.#modelEffort,
                    },
                };
            }
            if (this.#sessionLoad.kind === "loaded") {
                return this.#sessionLoad.history;
            }
        }
        return (await this.#loadSession(signal)).history;
    }

    async #loadSession(signal: AbortSignal): Promise<LoadedSession> {
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
                const opened = await this.#writeNativeHistory(
                    async () =>
                        await this.#adapter.openSessionWithReplay({
                            ...this.#sessionParams(signal),
                            nativeSessionId: this.nativeSessionId(),
                        }),
                );
                signal.throwIfAborted();
                this.#capabilities = opened.capabilities;
                const loaded = { history, kind: "loaded", opened } satisfies LoadedSession;
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

    readonly initialize = async (
        signal: AbortSignal,
        recovery: SessionRecovery,
        origin?: NativeSessionOrigin,
    ): Promise<void> =>
        await this.#writeNativeHistory(async () => await restoreSession(this, signal, recovery, origin));

    /**
     * Native clients, such as the Agent's own terminal, can continue the conversation
     * while this process is idle. The Agent would then answer from, and append to, the
     * copy it loaded earlier, so the caller must reopen the conversation from native history.
     */
    readonly nativeHistoryChanged = async (signal: AbortSignal): Promise<boolean> => {
        const baseline = this.#nativeHistoryBaseline;
        if (this.#writingNativeHistory()) {
            return false;
        }
        switch (baseline.kind) {
            case "unavailable":
                return false;
            case "recording":
                await waitForSharedOperation(baseline.completion, signal);
                return await this.nativeHistoryChanged(signal);
            case "recorded": {
                let current: NativeHistoryRevision;
                try {
                    current = await this.#readNativeHistoryRevision(signal);
                } catch (error) {
                    signal.throwIfAborted();
                    console.warn(`[${this.#agentId}-acp] Native history revision could not be read`, error);
                    return false;
                }
                // Our own writes that began meanwhile record a new baseline when they settle.
                return (
                    !this.#writingNativeHistory() &&
                    this.#nativeHistoryBaseline === baseline &&
                    current.kind === "tracked" &&
                    current.latestEntryId !== baseline.latestEntryId
                );
            }
            default: {
                const unreachable: never = baseline;
                throw new AcpExecutionError("Unexpected native history baseline", { cause: unreachable });
            }
        }
    };

    readonly #writingNativeHistory = (): boolean =>
        this.#nativeHistoryWrites > 0 || this.#backgroundActivity !== "none";

    /**
     * Runs an operation that may append to native history, then records what it left there.
     * The recording starts synchronously; a later comparison waits for it instead of the operation.
     */
    readonly #writeNativeHistory = async <T>(operation: () => Promise<T>): Promise<T> => {
        this.#nativeHistoryWrites += 1;
        try {
            return await operation();
        } finally {
            this.#nativeHistoryWrites -= 1;
            void this.#recordNativeHistoryRevision();
        }
    };

    readonly #readNativeHistoryRevision = async (signal: AbortSignal): Promise<NativeHistoryRevision> =>
        this.#nativeIdentity.kind === "bound"
            ? await this.#adapter.readNativeHistoryRevision({
                  ...this.#target(),
                  signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              })
            : { kind: "untracked" };

    readonly #recordNativeHistoryRevision = async (): Promise<void> => {
        if (this.#writingNativeHistory()) {
            return;
        }
        const recorded = Promise.withResolvers<void>();
        const recording: NativeHistoryBaseline = { kind: "recording", completion: recorded.promise };
        this.#nativeHistoryBaseline = recording;
        let baseline: NativeHistoryBaseline = { kind: "unavailable" };
        try {
            const revision = await this.#readNativeHistoryRevision(AbortSignal.timeout(30_000));
            if (revision.kind === "tracked") {
                baseline = { kind: "recorded", latestEntryId: revision.latestEntryId };
            }
        } catch (error) {
            // A released process has no writer left to compare; any other failure keeps reuse unchanged.
            if (!(error instanceof AcpExecutionError && error.code === "invalid_agent_session")) {
                console.warn(`[${this.#agentId}-acp] Native history revision could not be recorded`, error);
            }
        } finally {
            if (this.#nativeHistoryBaseline === recording) {
                this.#nativeHistoryBaseline = baseline;
            }
            recorded.resolve();
        }
    };

    readonly nativeSessionId = (): string => this.#nativeSessionId;

    readonly adoptNativeSessionId = (sessionId: string): void => {
        if (this.#prompted || this.#nativeSessionId !== sessionId) {
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
        const configured = await this.#writeNativeHistory(
            async () => await this.#adapter.configureSession({ ...this.#target(), selection, signal }),
        );
        if (this.#configRevision === configRevision) {
            this.#configOptions = configured;
            this.#configRevision = crypto.randomUUID();
            await this.#publishConfiguration();
        }
    };

    // The revision check and Agent mutation share one queue, including settings the Runtime applies itself.
    // A lost response may have committed: reread after a conflict, never replay an edit blindly.
    readonly configure = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#configurationChanges.run(async (signal) => {
            if (
                options.expectedConfigurationRevision !== null &&
                options.expectedConfigurationRevision !== this.#configRevision
            ) {
                throw new AcpExecutionError(
                    "Session settings changed. Review the current settings before applying your selection again.",
                    {},
                    "session_configuration_conflict",
                );
            }
            await this.#applyConfiguration(
                options.valueType === "boolean"
                    ? { type: "boolean", configId: options.configId, booleanValue: options.booleanValue }
                    : { type: "select", configId: options.configId, value: options.value },
                signal,
            );
            const applied = this.#configOptions.find((option) => option.id === options.configId);
            if (applied === undefined) {
                throw new AcpExecutionError("The requested ACP configuration option is unavailable");
            }
            this.#sessionConfigurations.select(applied);
            this.writeStoredSession(new Date().toISOString());
            return { configOptions: this.#configOptions, configurationRevision: this.#configRevision };
        }, options.signal);

    readonly #publishConfiguration = async (): Promise<void> => {
        // Use the existing v2 ACP event vocabulary so old observers can still decode the stream.
        const event = this.#store.events.append(this.#mobiusSessionId, {
            type: "acp",
            payload: {
                sessionUpdate: "config_option_update",
                configOptions: this.#configOptions.map((option) => ({
                    category: option.category,
                    description: option.description,
                    id: option.id,
                    name: option.name,
                    ...(option.type === "boolean"
                        ? { type: "boolean" as const, currentValue: option.booleanValue }
                        : { type: "select" as const, currentValue: option.currentValue, options: option.values }),
                })),
            },
        });
        await this.#getObserver().onSessionEvent?.(event);
        await this.emitConfigUpdate();
    };

    readonly #target = (): AdapterSessionTarget => ({
        nativeSessionId: this.#nativeSessionId,
        cwd: this.#cwd,
        additionalDirectories: this.#additionalDirectories,
    });

    readonly prompt = async (options: SessionTurnOptions): Promise<PromptResult> => {
        if (!this.#capabilities.loadSession && this.#sessionLoad.kind === "not-requested") {
            this.#sessionLoad = {
                kind: "loaded",
                history: new HistoryReplayCapture(this.#store.events, this.#mobiusSessionId),
                opened: {
                    nativeSessionId: this.nativeSessionId(),
                    capabilities: this.#capabilities,
                    configOptions: [],
                    agentName: this.#agentName,
                    agentVersion: this.#agentVersion,
                    agentSettingsModelEffort: this.#modelEffort,
                },
            };
        }
        if (this.#capabilities.loadSession && this.#sessionLoad.kind !== "execution-only") {
            await this.#completedHistory(options.signal);
        }
        validatePromptContent(options, this.#capabilities);
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
        if (this.#sessionTitle === null || this.#sessionTitle.length === 0) {
            this.#sessionTitle = conversationTitleFromText(options.prompt);
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
            const result = await this.#writeNativeHistory(
                async () => await this.#adapter.prompt({ ...this.#target(), content: options, signal: options.signal }),
            );
            this.writeStoredSession(new Date().toISOString());
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        stopReason: result.stopReason,
                    },
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
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
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
            const outcome = await this.#adapter.steer({ ...this.#target(), content: options, signal: options.signal });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        stopReason: "steered",
                    },
                    type: "lifecycle-metadata",
                });
            }
            return outcome.outcome;
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

    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        await this.#interactions.cancelPendingInteractions();
        signal.throwIfAborted();
        if (this.#turn.running) {
            return await this.#adapter.cancel({ ...this.#target(), signal });
        }
        return "retained";
    };

    readonly interactionSnapshot = (): SessionInteractionSnapshot => {
        const { sessionGenerationId, throughPosition } = this.#store.events.livePosition(this.#mobiusSessionId);
        return { sessionGenerationId, throughPosition, interactions: this.#interactions.snapshot() };
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
        if (this.#nativeSessionId.length > 0 && this.#nativeSessionId !== sessionId) {
            throw new AcpExecutionError(
                "ACP agent attempted to replace the selected session",
                {},
                "invalid_agent_session",
            );
        }
        this.#nativeIdentity = { kind: "bound", nativeSessionId: sessionId };
        this.#nativeHistoryOwnership = { kind: "agent-owned" };
    };

    readonly #processEvent = async (event: AdapterSessionEvent): Promise<void> => {
        if (event.kind === "configuration" || event.kind === "mode") {
            this.#configOptions =
                event.kind === "configuration"
                    ? event.configOptions
                    : this.#configOptions.map((option) =>
                          option.category === "mode" ? { ...option, currentValue: event.modeId } : option,
                      );
            this.#configRevision = crypto.randomUUID();
            this.#captureSelectedConfigurationValues();
        }
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
            case "mode":
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
                if (this.#nativeSessionId.length > 0) {
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
        if (this.#nativeSessionId.length === 0) {
            await this.closeProcess();
            return;
        }
        await this.#adapter.closeSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
    };

    readonly closeProcess = async (): Promise<void> => {
        if (this.#nativeIdentity.kind === "bound") {
            await this.#adapter.releaseSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
        }
        this.#backgroundActivity = "none";
    };

    readonly agentSettingsModelEffort = () => this.#modelEffort;
    readonly #sessionParams = (signal: AbortSignal): AdapterSessionCreateParams => ({
        ...this.#subscriber,
        scope: this.#scope,
        signal,
    });
    readonly createSession = (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.createSession(this.#sessionParams(signal));

    readonly forkSession = (sourceSessionId: string, signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.forkSession({ ...this.#sessionParams(signal), sourceNativeSessionId: sourceSessionId });

    readonly openSession = (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.openSession({ ...this.#sessionParams(signal), nativeSessionId: this.nativeSessionId() });

    readonly openSessionWithReplay = async (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        (await this.#loadSession(signal)).opened;

    setConfigOptions(options: readonly SessionConfigOption[]): void {
        this.#configOptions = options;
        this.#configRevision = crypto.randomUUID();
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
        if (sessionId !== this.#nativeSessionId) {
            throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
        }
    };

    readonly emitConfigUpdate = async (): Promise<void> => {
        await this.#getObserver().onConfig({
            configOptions: this.#configOptions,
            configurationRevision: this.#configRevision,
            kind: SESSION_CONFIG_UPDATED_KIND,
            requestId: `agent-update-${crypto.randomUUID()}`,
            sessionId: this.#mobiusSessionId,
        });
    };
}
