import { setImmediate as yieldToRuntime } from "node:timers/promises";
import {
    type CompleteElicitationNotification,
    type ContentBlock,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
    decodeAcpSessionUpdate,
    decodeAgentPromptResponse,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_INFO_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
    type SessionEventPayload,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { buildPromptContent } from "../../acp/client/prompt-content.ts";
import { AgentConnection } from "../../acp/connection/agent-connection.ts";
import { AgentUpdateStream } from "../../acp/connection/agent-update-stream.ts";
import type { AcpClientHandler } from "../../acp/connection/create-client.ts";
import type { AcpContentExternalizer } from "../../acp/content/content-externalizer.ts";
import {
    type NativeSessionOrigin,
    type NativeSessionPage,
    nativeSessionPageSchema,
} from "../../acp/protocol/native-session.ts";
import { normalizeAcpCapabilities, unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import {
    type SessionConfigProtocol,
    SessionConfigProtocolError,
    sessionConfigProtocolForAgent,
} from "../../acp/protocol/session-config-protocol.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../../infra/operation-metrics.ts";
import { revalidateExecutable } from "../../util/process/executable.ts";
import { isRecord, truncate } from "../../util/value-utils.ts";
import {
    type ElicitationResponseOptions,
    type PermissionResponseOptions,
    PreparedSession,
    type PromptContentOptions,
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
import { type AgentTurnState, IdleAgentTurn, RunningAgentTurn } from "./agent-turn.ts";
import { SessionConfigurations } from "./session-configurations.ts";
import { restoreSession } from "./session-restore.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp/acp-error.ts";

class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

type SessionLoadState =
    | { readonly kind: "not-requested" }
    | {
          readonly completion: Promise<LoadedSession>;
          readonly history: HistoryReplayCapture;
          readonly kind: "capturing";
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

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length && leftEntries.every(([name, value]) => right[name] === value);
}

export class AgentSession implements AcpClientHandler, AgentSessionRestore {
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

    readonly #connection: AgentConnection;
    readonly #contentExternalizer: AcpContentExternalizer;
    readonly #interactions: SessionInteractions;
    readonly #additionalDirectories: readonly string[];
    readonly #agentId: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => SessionObserver;
    #mobiusSessionId: string;
    readonly #updates: AgentUpdateStream;
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
    #nativePrompt: { readonly commandId: string; readonly previousTurnId: string | null } | null = null;
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
        contentExternalizer: AcpContentExternalizer,
    ) {
        this.#updates = new AgentUpdateStream((notification) => this.#processUpdate(notification));
        this.#additionalDirectories = [...additionalDirectories];
        this.#agentId = agent.id;
        this.#commands = [];
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#getObserver = getObserver;
        this.#mobiusSessionId = mobiusSessionId;
        this.#metrics = metrics;
        this.#sessionConfigProtocol = sessionConfigProtocolForAgent(agent.id);
        this.#store = store;
        this.#verifiedAgentVersion = agent.agentVersion;
        this.#interactions = new SessionInteractions({
            cwd: () => this.#cwd,
            getToolCall: (toolCallId) => this.#store.events.getToolCall(this.#mobiusSessionId, toolCallId),
            sessionId: () => this.#mobiusSessionId,
            commandId: () => this.#turn.commandId,
            assertNativeSession: (sessionId) => this.assertNativeSession(sessionId),
            observer: getObserver,
            recordSessionEvent: this.recordLifecycleEvent,
        });
        this.#connection = new AgentConnection(agent, cwd, this);
        this.#contentExternalizer = contentExternalizer;
    }

    static async #start(
        options: SessionPrepareOptions,
        getObserver: () => SessionObserver,
        store: SessionStore,
        initialize: (runtime: AgentSession) => Promise<void>,
        metrics: OperationMetrics,
        contentExternalizer: AcpContentExternalizer,
    ): Promise<AgentSession> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            options.signal.throwIfAborted();
            const unchanged = await metrics.measure(
                "executable-validation",
                async () =>
                    await Promise.all([
                        // Only the adapter topology has an adapter executable to revalidate.
                        options.agent.kind === "acp-adapter-process"
                            ? revalidateExecutable(options.agent.adapterIdentity)
                            : Promise.resolve(true),
                        revalidateExecutable(options.agent.agentIdentity),
                    ]),
            );
            options.signal.throwIfAborted();
            if (unchanged.some((result) => !result)) {
                throw new AcpExecutionError(
                    "The local Agent runtime changed; restart Mobius before starting a new conversation",
                    {},
                    "agent_runtime_changed",
                );
            }
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
                        contentExternalizer,
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
        contentExternalizer: AcpContentExternalizer,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.initialize(options.signal, recovery, options.origin),
            metrics,
            contentExternalizer,
        );

    static readonly startNativeSessionBrowser = async (
        options: SessionPrepareOptions,
        getObserver: () => SessionObserver,
        store: SessionStore,
        contentExternalizer: AcpContentExternalizer,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.#initializeAgent(options.signal),
            unmeasuredOperationMetrics,
            contentExternalizer,
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
        if (this.#capabilities.renameSession && nativeSessionId.length > 0) {
            try {
                await this.race(
                    this.#connection.connection.agent.request(
                        "_session/rename",
                        { sessionId: nativeSessionId, title: normalized },
                        { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                    ),
                    "ACP agent exited while renaming the Session",
                    signal,
                );
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError(
                    "The Agent could not rename the Session",
                    { cause: error },
                    "session_rename_failed",
                );
            }
        }
        const updatedAt = new Date().toISOString();
        await this.#processUpdate({
            sessionId: nativeSessionId,
            update: { sessionUpdate: "session_info_update", title: normalized, updatedAt },
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
            async (selection, signal) =>
                await this.#applyConfiguration(
                    selection.configId,
                    selection.type === "select" ? selection.value : "",
                    selection.type === "boolean" ? selection.booleanValue : false,
                    selection.type,
                    signal,
                ),
            signal,
        );
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
        if (this.#connection.inProcessAgent !== null) {
            // The ACP agent runs in this process, but it still owns an app-server child that must
            // start and complete its own handshake before the ACP conversation can begin.
            await this.race(
                this.#connection.inProcessAgent.initialize(signal),
                "The Codex app-server exited during initialization",
                signal,
            ).catch((cause: unknown) => {
                signal.throwIfAborted();
                throw new RetryableAcpInitializationError(cause);
            });
        }
        const initialized = await this.race(
            this.#connection.connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {
                        elicitation: { form: {}, url: {} },
                        plan: {},
                        session: { compaction: {}, configOptions: { boolean: {} } },
                    },
                    clientInfo: { name: "mobius", version: "0.0.3" },
                    protocolVersion: PROTOCOL_VERSION,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during initialization",
            signal,
        ).catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
            throw new AcpExecutionError(
                "ACP agent selected an unsupported protocol version",
                {},
                "unsupported_acp_protocol",
            );
        }
        this.#capabilities = normalizeAcpCapabilities(initialized);
        this.#agentName = truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? this.#agentId, 255);
        this.#agentVersion = truncate(
            this.#verifiedAgentVersion.length > 0 ? this.#verifiedAgentVersion : (initialized.agentInfo?.version ?? ""),
            128,
        );
    }

    readonly initialize = async (
        signal: AbortSignal,
        recovery: SessionRecovery,
        origin?: NativeSessionOrigin,
    ): Promise<void> => await restoreSession(this, signal, recovery, origin);

    readonly listNativeSessions = async (cursor: string | null, signal: AbortSignal): Promise<NativeSessionPage> => {
        if (!this.#capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const response: unknown = await this.race(
            this.#connection.connection.agent.request(methods.agent.session.list, cursor === null ? {} : { cursor }, {
                cancellationSignal: signal,
            }),
            "ACP agent exited while listing sessions",
            signal,
        );
        const decoded = nativeSessionPageSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The Agent returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

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
        configId: string,
        value: string,
        booleanValue: boolean,
        valueType: SessionConfigOption["type"],
        signal: AbortSignal,
    ): Promise<void> => {
        const existing = this.#configOptions.find((option) => option.id === configId);
        if (existing === undefined || existing.type !== valueType) {
            throw new AcpExecutionError(
                "The requested ACP configuration option is unavailable",
                {},
                "invalid_session_configuration",
            );
        }
        if (existing.type === "select") {
            if (existing.values.length < 2) {
                throw new AcpExecutionError(
                    "The requested ACP configuration option is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            if (!existing.values.some((entry) => entry.value === value)) {
                throw new AcpConfigurationValueUnavailableError(
                    configId,
                    value,
                    existing.values.map((entry) => entry.value),
                );
            }
        }
        const configRevision = this.#configRevision;
        try {
            const configured = await this.#sessionConfigProtocol.configure(
                this.#configOptions,
                { booleanValue, configId, signal, value },
                this.#updates.sessionId(),
                {
                    request: async (method, params, failureMessage, signal) =>
                        await this.race(
                            this.#connection.connection.agent.request(method, params, {
                                cancellationSignal: signal,
                            }),
                            failureMessage,
                            signal,
                        ),
                },
            );
            const applied = configured.find((option) => option.id === configId);
            if (
                applied === undefined ||
                applied.type !== valueType ||
                (applied.type === "boolean" && applied.booleanValue !== booleanValue) ||
                (applied.type === "select" && applied.currentValue !== value)
            ) {
                throw new AcpExecutionError(
                    "The Agent did not apply the requested session configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            await this.#updates.drained();
            if (this.#configRevision === configRevision) {
                this.#configOptions = configured;
            }
        } catch (error) {
            if (error instanceof SessionConfigProtocolError) {
                throw new AcpExecutionError(error.message, { cause: error }, error.code);
            }
            throw error;
        }
    };

    readonly configure = async (options: SessionConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        await this.#applyConfiguration(
            options.configId,
            options.value,
            options.booleanValue,
            options.valueType,
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

    readonly buildPrompt = (options: PromptContentOptions): ContentBlock[] =>
        buildPromptContent(options, this.#capabilities);

    readonly nativeHistoryTurn = (): { readonly commandId: string; readonly nativeTurnId: string } | null => {
        const prompt = this.#nativePrompt;
        const nativeTurnId = this.#connection.inProcessAgent?.nativeTurnId?.() ?? null;
        return prompt === null || nativeTurnId === null || nativeTurnId === prompt.previousTurnId
            ? null
            : { commandId: prompt.commandId, nativeTurnId };
    };

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
        if (this.#capabilities.loadSession) {
            await this.#completedHistory(options.signal, "ACP agent exited while loading history before a prompt");
        }
        const prompt = this.buildPrompt(options);
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
        this.#nativePrompt = {
            commandId: options.commandId,
            previousTurnId: this.#connection.inProcessAgent?.nativeTurnId?.() ?? null,
        };
        try {
            const response: unknown = await this.race(
                this.#connection.connection.agent.request(
                    methods.agent.session.prompt,
                    { prompt, sessionId: this.#updates.sessionId() },
                    { cancellationSignal: options.signal },
                ),
                "ACP agent exited during a prompt",
                options.signal,
            );
            await this.#updates.drained();
            let result: PromptResult;
            try {
                result = decodeAgentPromptResponse(response);
            } catch (cause) {
                throw new AcpExecutionError(
                    "ACP agent returned an invalid prompt response",
                    { cause },
                    "acp_invalid_prompt_response",
                );
            }
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
        const prompt = this.buildPrompt(options);
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
            const response: unknown = await this.race(
                this.#connection.connection.agent.request("_session/steering", {
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                    prompt,
                    sessionId: this.#updates.sessionId(),
                }),
                "ACP agent exited during steering",
                options.signal,
            );
            if (!isRecord(response)) {
                throw new AcpExecutionError(
                    "ACP agent returned an invalid steering response",
                    {},
                    "acp_invalid_steering_response",
                );
            }
            const outcome = response["outcome"];
            if (outcome === "injected" || outcome === "startedNewTurn") {
                if (lifecycle !== undefined) {
                    await this.recordLifecycleEvent({
                        payload: { commandId: options.commandId, kind: "prompt.completed", stopReason: "steered" },
                        type: "lifecycle-metadata",
                    });
                }
                return outcome;
            }
            if (outcome === "promptRequired") {
                throw new AcpExecutionError(
                    "The target turn finished before steering could be injected",
                    {},
                    "steering_target_unavailable",
                );
            }
            if (outcome === "failed") {
                throw new AcpExecutionError("The Agent could not inject steering", {}, "steering_failed");
            }
            throw new AcpExecutionError(
                "ACP agent returned an invalid steering response",
                {},
                "acp_invalid_steering_response",
            );
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

    readonly cancel = async (): Promise<void> => {
        await this.#interactions.cancelPendingInteractions();
        if (this.#turn.running) {
            await this.#connection.connection.agent.notify(methods.agent.session.cancel, {
                sessionId: this.#updates.sessionId(),
            });
        }
    };

    readonly respondPermission = (options: PermissionResponseOptions) => this.#interactions.respondPermission(options);
    readonly respondElicitation = (options: ElicitationResponseOptions) =>
        this.#interactions.respondElicitation(options);
    readonly onPermission = async (request: RequestPermissionRequest, signal: AbortSignal) => {
        // The ACP connection dispatches incoming messages concurrently, so this
        // request can reach its handler before updates the Agent wrote earlier.
        // Those updates were already read; one turn of the event loop lets them
        // reach the update stream, and draining it applies the tool call this
        // request references before the permission is described.
        await yieldToRuntime(undefined, { signal });
        await this.#updates.drained();
        signal.throwIfAborted();
        return await this.#interactions.onPermission(request, signal);
    };
    readonly onElicitation = (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => this.#interactions.onElicitation(request, signal);
    readonly onElicitationComplete = (notification: CompleteElicitationNotification) =>
        this.#interactions.onElicitationComplete(notification);

    readonly onUpdate = (notification: SessionNotification): Promise<void> => this.#updates.receive(notification);

    readonly recordControlEvent = async (event: SessionEventPayload): Promise<boolean> => {
        if (this.#sessionLoad.kind !== "loaded") {
            return false;
        }
        await this.recordLifecycleEvent(event);
        return true;
    };

    readonly recordLifecycleEvent = async (event: SessionEventPayload): Promise<void> => {
        if (event.type !== "lifecycle-metadata" || this.#sessionLoad.kind !== "loaded") {
            return;
        }
        const liveEvent = this.#sessionLoad.history.recordLifecycle(event);
        await this.#getObserver().onSessionEvent?.(liveEvent);
    };

    readonly selectNativeSession = (sessionId: string): void => {
        this.#updates.select(sessionId);
        this.#nativeHistoryOwnership = { kind: "agent-owned" };
    };

    readonly #processUpdate = async (notification: SessionNotification): Promise<void> => {
        this.assertNativeSession(notification.sessionId);
        const externalized = await this.#contentExternalizer.update(
            this.#mobiusSessionId,
            notification.update,
            AbortSignal.timeout(30_000),
        );
        const update = externalized.agent;
        const rawUpdate = decodeAcpSessionUpdate(JSON.stringify(externalized.event));
        if (this.#sessionLoad.kind === "capturing") {
            await this.#sessionLoad.history.record(update, rawUpdate);
        } else if (this.#sessionLoad.kind === "loaded") {
            const onSessionEvent = this.#getObserver().onSessionEvent;
            await this.#sessionLoad.history.record(update, rawUpdate, async (liveEvent) => {
                await onSessionEvent?.(liveEvent);
            });
        }
        if (
            this.#sessionLoad.kind === "capturing" &&
            (update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update" ||
                update.sessionUpdate === "plan" ||
                update.sessionUpdate === "plan_update" ||
                update.sessionUpdate === "plan_removed")
        ) {
            return;
        }
        if (update.sessionUpdate === "available_commands_update") {
            const commands: SessionCommand[] = update.availableCommands
                .slice(0, 500)
                .map((command) => ({
                    description: truncate(command.description, 500),
                    inputHint: truncate(command.input?.hint ?? "", 255),
                    name: truncate(command.name, 128),
                }))
                .filter((command) => command.name.length > 0);
            this.#commands = commands;
            await this.#getObserver().onCommands({
                commands: this.#commands,
                kind: SESSION_COMMANDS_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
            });
            return;
        }
        if (update.sessionUpdate === "config_option_update") {
            this.#configOptions = this.#sessionConfigProtocol.normalizeUpdate(
                this.#configOptions,
                update.configOptions,
            );
            this.#configRevision += 1;
            this.#captureSelectedConfigurationValues();
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "current_mode_update") {
            this.#configOptions = this.#configOptions.map((option) =>
                option.category === "mode" ? { ...option, currentValue: update.currentModeId } : option,
            );
            this.#configRevision += 1;
            this.#captureSelectedConfigurationValues();
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "session_info_update") {
            if (Object.hasOwn(update, "title")) {
                this.#sessionTitle = truncate(update.title ?? "", 500);
            }
            if (Object.hasOwn(update, "updatedAt")) {
                this.#sessionUpdatedAt = truncate(update.updatedAt ?? "", 128);
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
            if (this.#capabilities.closeSession && this.#updates.sessionId().length > 0) {
                try {
                    await this.#connection.connection.agent.request(
                        methods.agent.session.close,
                        { sessionId: this.#updates.sessionId() },
                        {
                            cancellationSignal: AbortSignal.timeout(PROCESS_STOP_TIMEOUT_MILLISECONDS),
                        },
                    );
                } catch {
                    // Process teardown below remains authoritative.
                }
            }
        } finally {
            await this.closeProcess();
        }
    };

    readonly closeProcess = (): Promise<void> => this.#connection.closeProcess();

    readonly agentSettingsModelEffort = () => this.#connection.inProcessAgent?.agentSettingsModelEffort?.() ?? null;
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

/**
 * The state and operations session restore needs. AgentSession implements it; keeping it
 * declared beside the class documents exactly what the restore decision tree may touch.
 */
export interface AgentSessionRestore {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly capabilities: SessionCapabilities;
    readonly cwd: string;
    readonly metrics: OperationMetrics;
    readonly restored: boolean;
    readonly sessionId: string;
    readonly sessionConfigProtocol: SessionConfigProtocol;
    readonly store: SessionStore;
    agentRequest<Params, Result>(
        method: string,
        params: Params,
        options?: { cancellationSignal?: AbortSignal },
    ): Promise<Result>;
    drained(): Promise<void>;
    initializeAgent(signal: AbortSignal): Promise<void>;
    loadSession(signal: AbortSignal, exitMessage: string): Promise<{ response: unknown }>;
    nativeSessionId(): string;
    race<T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T>;
    restoreStoredConfigurations(session: StoredSession, signal: AbortSignal): Promise<void>;
    selectNativeSession(sessionId: string): void;
    setConfigOptions(options: readonly SessionConfigOption[]): void;
    setNativeHistoryOwnership(
        ownership: { kind: "unbound" } | { kind: "fresh-session" } | { kind: "agent-owned" },
    ): void;
    setPrompted(prompted: boolean): void;
    setRestored(restored: boolean): void;
    setSessionTitle(title: string): void;
    writeStoredSession(updatedAt: string): void;
}
