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
    AGENT_CONTENT_KIND,
    type AgentDisplayContent,
    decodeAcpSessionUpdateV2,
    decodeAgentPromptResponse,
    type NativeSessionHistory,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";
import type { LocalRasterImage } from "../authorization/local-raster.ts";
import { readInlineRaster, readLocalRaster } from "../authorization/local-raster.ts";
import { type LocalVideo, readInlineVideo } from "../authorization/local-video.ts";
import type { AcpAgentDefinition } from "../config.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../infra/operation-metrics.ts";
import { embedLocalHistoryImages } from "../native-sessions/history-images.ts";
import { type ProcessTreeIdentity, revalidateExecutable } from "../process/executable.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";
import { imageDisplayContent, isProgressMessage, normalizeContentBlock } from "./activity-content.ts";
import { AgentConnection } from "./agent-connection.ts";
import { type AcpTurnState, IdleAcpTurn, RunningAcpTurn } from "./agent-turn.ts";
import { AgentUpdateStream } from "./agent-update-stream.ts";
import type { AcpClientHandler } from "./create-client.ts";
import {
    type NativeSessionOrigin,
    type NativeSessionPage,
    nativeSessionIdSchema,
    nativeSessionPageSchema,
} from "./native-session.ts";
import { waitForSharedOperation } from "./runtime-operations.ts";
import { normalizeAcpCapabilities, unsupportedSessionCapabilities } from "./session-capabilities.ts";
import { type SessionConfigProtocol, SessionConfigProtocolError } from "./session-config/session-config-protocol.ts";
import { sessionConfigProtocolForAgent } from "./session-config/session-config-registry.ts";
import {
    type AcpConfigureOptions,
    type AcpElicitationResponseOptions,
    type AcpNativeEventReplayV2,
    type AcpPermissionResponseOptions,
    AcpPreparedSession,
    type AcpPrepareOptions,
    type AcpPromptContentOptions,
    type AcpPromptResult,
    type AcpSessionObserver,
    type AcpSteerOptions,
    type AcpTurnOptions,
} from "./session-contracts.ts";
import { readAcpSessionFailure } from "./session-failure.ts";
import { AcpHistoryReplay } from "./session-history.ts";
import { AcpSessionInteractions } from "./session-interactions.ts";
import {
    type AcpSessionStore,
    AcpStoredSession,
    DeletedAcpStoredSession,
    FoundAcpStoredSession,
} from "./session-store.ts";
import { isRecord, truncate } from "./value-utils.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";

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
          readonly history: AcpHistoryReplay;
          readonly kind: "capturing";
      }
    | LoadedSession;

type NativeHistoryOwnership =
    | { readonly kind: "unbound" }
    | { readonly kind: "fresh-session" }
    | { readonly kind: "agent-owned" };

interface LoadedSession {
    readonly history: AcpHistoryReplay;
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

export class AgentSession implements AcpClientHandler {
    readonly #connection: AgentConnection;
    readonly #interactions: AcpSessionInteractions;
    readonly #additionalDirectories: readonly string[];
    readonly #agentId: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => AcpSessionObserver;
    #mobiusSessionId: string;
    readonly #updates: AgentUpdateStream;
    readonly #metrics: OperationMetrics;
    readonly #sessionConfigProtocol: SessionConfigProtocol;
    readonly #store: AcpSessionStore;
    readonly #verifiedAgentVersion: string;
    #agentName = "";
    #agentVersion = "";
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    #configRevision = 0;
    #configOptions: readonly SessionConfigOption[] = [];
    #lastTerminalCommandId: string | null = null;
    #nativeHistoryOwnership: NativeHistoryOwnership = { kind: "unbound" };
    #prompted = false;
    #nativePrompt: { readonly commandId: string; readonly previousTurnId: string | null } | null = null;
    #sessionLoad: SessionLoadState = { kind: "not-requested" };
    #restored = false;
    #sessionTitle: string | null = null;
    #sessionUpdatedAt = "";
    #turn: AcpTurnState = new IdleAcpTurn();

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        additionalDirectories: readonly string[],
        mobiusSessionId: string,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        metrics: OperationMetrics,
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
        this.#interactions = new AcpSessionInteractions({
            sessionId: () => this.#mobiusSessionId,
            commandId: () => this.#turn.commandId,
            assertNativeSession: (sessionId) => this.assertNativeSession(sessionId),
            observer: getObserver,
        });
        this.#connection = new AgentConnection(agent, cwd, this);
    }

    static async #start(
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        initialize: (runtime: AgentSession) => Promise<void>,
        metrics: OperationMetrics,
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
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.initialize(options.signal, options.origin),
            metrics,
        );

    static readonly startNativeSessionBrowser = async (
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.#initializeAgent(options.signal),
            unmeasuredOperationMetrics,
        );

    readonly belongsTo = (agentId: string, cwd: string, additionalDirectories: readonly string[]): boolean =>
        this.#agentId === agentId &&
        this.#cwd === cwd &&
        arraysEqual(this.#additionalDirectories, additionalDirectories);

    readonly usesEnvironment = (environment: Readonly<Record<string, string>>): boolean =>
        recordsEqual(this.#environment, environment);

    readonly canRebind = (): boolean => !this.#prompted && !this.#turn.running;

    readonly hasRunningTurn = (): boolean => this.#turn.running;

    readonly prepared = (): AcpPreparedSession =>
        new AcpPreparedSession(
            this.#agentName,
            this.#agentVersion,
            this.#capabilities,
            this.#commands,
            this.#configOptions,
            this.#prompted,
            this.#restored,
        );

    readonly loadHistory = async (signal: AbortSignal): Promise<NativeSessionHistory> => {
        if (!this.#capabilities.loadSession) {
            return {
                status: "unavailable",
                cause: {
                    code: "native_history_unsupported",
                    message: "This Agent restores context but does not provide message history.",
                },
            };
        }
        const loaded = await this.#loadSession(signal, "ACP agent exited while loading history");
        return await embedLocalHistoryImages(await loaded.history.snapshot(), signal);
    };

    readonly loadHistoryEventsV2 = async (
        eventLimit: number,
        cursor: string | null,
        signal: AbortSignal,
    ): Promise<AcpNativeEventReplayV2> => {
        if (!this.#prompted && this.#nativeHistoryOwnership.kind === "fresh-session") {
            return new AcpHistoryReplay().eventPage(eventLimit, cursor);
        }
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        const loaded = await this.#loadSession(signal, "ACP agent exited while loading history");
        return loaded.history.eventPage(eventLimit, cursor);
    };

    async #loadSession(signal: AbortSignal, exitMessage: string): Promise<LoadedSession> {
        if (this.#sessionLoad.kind === "loaded") {
            return this.#sessionLoad;
        }
        if (this.#sessionLoad.kind === "capturing") {
            return await waitForSharedOperation(this.#sessionLoad.completion, signal);
        }
        const history = new AcpHistoryReplay();
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

    private readonly prepareAgentContent = async (content: AgentDisplayContent): Promise<AgentDisplayContent> => {
        if (content.type === "image" && content.uri.length > 0) {
            const signal = AbortSignal.timeout(20_000);
            const raster = await readLocalRaster(content.uri, signal);
            if (raster !== null) {
                return await this.importRaster(raster, signal);
            }
        }
        if (content.type === "image" && content.data.length > 0) {
            const raster = readInlineRaster(content.data, content.name);
            if (raster !== null) {
                return await this.importRaster(raster, AbortSignal.timeout(20_000));
            }
        }
        if (content.type === "video" && content.data.length > 0) {
            const video = readInlineVideo(content.data, content.mimeType, content.name);
            if (video === null) {
                return { ...content, data: "" };
            }
            return this.importVideo(video);
        }
        return content;
    };

    private readonly emitAgentContent = async (content: AgentDisplayContent, messageId: string): Promise<void> => {
        const prepared = await this.prepareAgentContent(content);
        await this.#getObserver().onContent({
            commandId: this.#turn.commandId,
            content: prepared,
            contentId: `content-${crypto.randomUUID()}`,
            kind: AGENT_CONTENT_KIND,
            messageId,
            sessionId: this.#mobiusSessionId,
        });
    };

    private readonly importRaster = async (
        raster: LocalRasterImage,
        _signal: AbortSignal,
    ): Promise<AgentDisplayContent> => {
        if (raster.sourceUri.length > 0) {
            return {
                ...imageDisplayContent(raster.mimeType, raster.name, "", ""),
                uri: raster.sourceUri,
            };
        }
        return imageDisplayContent(raster.mimeType, raster.name, await raster.base64(), "");
    };

    private readonly importVideo = (video: LocalVideo): AgentDisplayContent => ({
        artifactId: "",
        data: video.base64(),
        mimeType: video.mimeType,
        name: video.name,
        newText: "",
        oldText: "",
        path: "",
        terminalId: "",
        text: "",
        type: "video",
        uri: "",
    });

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
                        _meta: {
                            jetbrains: { air: { capabilities: ["sessionFailure"], version: 1 } },
                        },
                        elicitation: { form: {}, url: {} },
                        plan: {},
                        session: { configOptions: { boolean: {} } },
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

    readonly initialize = async (signal: AbortSignal, origin?: NativeSessionOrigin): Promise<void> => {
        await this.#initializeAgent(signal);
        let stored = this.#metrics.measureSync("session-state-read", () =>
            origin?.kind === "import"
                ? new FoundAcpStoredSession(
                      new AcpStoredSession(
                          this.#mobiusSessionId,
                          this.#agentId,
                          nativeSessionIdSchema.parse(origin.nativeSessionId),
                          this.#cwd,
                          this.#additionalDirectories,
                          true,
                          "",
                      ),
                  )
                : this.#store.read(this.#mobiusSessionId),
        );
        if (stored instanceof FoundAcpStoredSession && !stored.session.prompted) {
            this.#store.remove(this.#mobiusSessionId);
            stored = this.#metrics.measureSync("session-state-read", () => this.#store.read(this.#mobiusSessionId));
        }
        if (stored instanceof DeletedAcpStoredSession) {
            throw new AcpExecutionError(
                "The native Agent session was deleted. Start a new chat.",
                {},
                "native_session_deleted",
            );
        }
        let lifecycleResponse: unknown;
        if (origin?.kind === "fork") {
            if (!this.#capabilities.unstableForkSession) {
                throw new AcpExecutionError(
                    "This Agent does not support session forking",
                    {},
                    "native_session_unsupported",
                );
            }
            if (this.#additionalDirectories.length > 0 && !this.#capabilities.additionalDirectories) {
                throw new AcpExecutionError(
                    "This Agent cannot restore additional working directories",
                    {},
                    "native_session_unsupported",
                );
            }
            const forked = await this.#metrics.measure(
                "session-fork",
                async () =>
                    await this.race(
                        this.#connection.connection.agent.request(
                            methods.agent.session.fork,
                            {
                                sessionId: nativeSessionIdSchema.parse(origin.nativeSessionId),
                                cwd: this.#cwd,
                                additionalDirectories: [...this.#additionalDirectories],
                                mcpServers: [],
                            },
                            { cancellationSignal: signal },
                        ),
                        "ACP agent exited while forking a session",
                        signal,
                    ),
            );
            this.selectNativeSession(forked.sessionId);
            if (
                this.#updates.sessionId() === origin.nativeSessionId ||
                this.#store.findNative(this.#agentId, this.#updates.sessionId()).length > 0
            ) {
                throw new AcpExecutionError(
                    "The Agent did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            this.#prompted = true;
            this.#restored = true;
            lifecycleResponse = forked;
        } else if (
            stored instanceof FoundAcpStoredSession &&
            stored.session.agentId === this.#agentId &&
            stored.session.cwd === this.#cwd &&
            arraysEqual(stored.session.additionalDirectories, this.#additionalDirectories)
        ) {
            this.selectNativeSession(stored.session.nativeSessionId);
            this.#prompted = stored.session.prompted;
            this.#lastTerminalCommandId = stored.session.lastTerminalCommandId;
            this.#sessionTitle = stored.session.title;
            this.#restored = true;
            if (this.#capabilities.resumeSession) {
                lifecycleResponse = await this.#metrics.measure(
                    "session-resume",
                    async () =>
                        await this.race(
                            this.#connection.connection.agent.request(
                                methods.agent.session.resume,
                                {
                                    additionalDirectories: [...this.#additionalDirectories],
                                    cwd: this.#cwd,
                                    mcpServers: [],
                                    sessionId: this.#updates.sessionId(),
                                },
                                { cancellationSignal: signal },
                            ),
                            "ACP agent exited while resuming a session",
                            signal,
                        ),
                );
            } else if (this.#capabilities.loadSession) {
                lifecycleResponse = await this.#metrics.measure(
                    "session-load",
                    async () => (await this.#loadSession(signal, "ACP agent exited while loading a session")).response,
                );
            } else {
                throw new AcpExecutionError(
                    "The ACP agent cannot restore its persisted session",
                    {},
                    "session_restore_unsupported",
                );
            }
        } else {
            if (stored instanceof FoundAcpStoredSession) {
                if (stored.session.prompted) {
                    throw new AcpExecutionError(
                        "The agent or workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                this.#store.remove(this.#mobiusSessionId);
            }
            const created = await this.#metrics.measure(
                "session-new",
                async () =>
                    await this.race(
                        this.#connection.connection.agent.request(
                            methods.agent.session.new,
                            {
                                additionalDirectories: [...this.#additionalDirectories],
                                cwd: this.#cwd,
                                mcpServers: [],
                            },
                            { cancellationSignal: signal },
                        ),
                        "ACP agent exited while starting a session",
                        signal,
                    ),
            );
            this.selectNativeSession(created.sessionId);
            this.#nativeHistoryOwnership = { kind: "fresh-session" };
            lifecycleResponse = created;
        }
        this.#configOptions = this.#sessionConfigProtocol.normalizeLifecycle(lifecycleResponse);
        await this.#updates.drained();
        signal.throwIfAborted();
        this.#store.write(
            new AcpStoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#updates.sessionId(),
                this.#cwd,
                this.#additionalDirectories,
                this.#prompted,
                this.#sessionTitle ?? "",
                new Date().toISOString(),
                this.#lastTerminalCommandId,
            ),
        );
    };

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

    readonly deleteNativeSession = async (nativeSessionId: string, signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.deleteSession || !this.#capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session deletion",
                {},
                "native_session_unsupported",
            );
        }
        await this.race(
            this.#connection.connection.agent.request(
                methods.agent.session.delete,
                { sessionId: nativeSessionIdSchema.parse(nativeSessionId) },
                { cancellationSignal: signal },
            ),
            "ACP agent exited while deleting a session",
            signal,
        );
    };

    readonly nativeSessionId = (): string => this.#updates.sessionId();

    readonly adoptNativeSessionId = (sessionId: string): void => {
        if (this.#prompted || this.#updates.sessionId() !== sessionId) {
            throw new AcpExecutionError("The new native Session cannot be adopted", {}, "session_identity_mismatch");
        }
        const previousSessionId = this.#mobiusSessionId;
        this.#store.write(
            new AcpStoredSession(
                sessionId,
                this.#agentId,
                sessionId,
                this.#cwd,
                this.#additionalDirectories,
                false,
                "",
            ),
        );
        this.#store.remove(previousSessionId);
        this.#mobiusSessionId = sessionId;
    };

    readonly configure = async (options: AcpConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        const existing = this.#configOptions.find((option) => option.id === options.configId);
        if (existing === undefined || existing.type !== options.valueType) {
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
            if (!existing.values.some((entry) => entry.value === options.value)) {
                throw new AcpConfigurationValueUnavailableError(
                    options.configId,
                    options.value,
                    existing.values.map((entry) => entry.value),
                );
            }
        }
        const configRevision = this.#configRevision;
        try {
            const configured = await this.#sessionConfigProtocol.configure(
                this.#configOptions,
                options,
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
            const applied = configured.find((option) => option.id === options.configId);
            if (
                applied === undefined ||
                applied.type !== options.valueType ||
                (applied.type === "boolean" && applied.booleanValue !== options.booleanValue) ||
                (applied.type === "select" && applied.currentValue !== options.value)
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
        return this.#configOptions;
    };

    readonly buildPrompt = (options: AcpPromptContentOptions): ContentBlock[] => {
        if (options.images.length > 0 && !this.#capabilities.imagePrompt) {
            throw new AcpExecutionError(
                "The selected agent does not accept image prompts",
                {},
                "unsupported_prompt_content",
            );
        }
        if (
            options.resources.some((resource) => resource.type === "embedded") &&
            !this.#capabilities.embeddedContextPrompt
        ) {
            throw new AcpExecutionError(
                "The selected agent does not accept embedded context",
                {},
                "unsupported_prompt_content",
            );
        }
        const prompt: ContentBlock[] = [];
        if (options.prompt.length > 0) {
            prompt.push({ text: options.prompt, type: "text" });
        }
        for (const image of options.images) {
            prompt.push({
                _meta: { mobius: { name: image.name } },
                data: image.data,
                mimeType: image.mimeType,
                type: "image",
            });
        }
        for (const resource of options.resources) {
            if (resource.type === "embedded") {
                prompt.push({
                    resource: {
                        mimeType: resource.mimeType,
                        text: resource.text,
                        uri: resource.uri,
                    },
                    type: "resource",
                });
            } else {
                prompt.push({
                    mimeType: resource.mimeType,
                    name: resource.name,
                    type: "resource_link",
                    uri: resource.uri,
                });
            }
        }
        if (prompt.length === 0) {
            throw new AcpExecutionError("A prompt must contain text or an attachment", {}, "empty_prompt");
        }
        return prompt;
    };

    readonly nativeHistoryTurn = (): { readonly commandId: string; readonly nativeTurnId: string } | null => {
        const prompt = this.#nativePrompt;
        const nativeTurnId = this.#connection.inProcessAgent?.nativeTurnId?.() ?? null;
        return prompt === null || nativeTurnId === null || nativeTurnId === prompt.previousTurnId
            ? null
            : { commandId: prompt.commandId, nativeTurnId };
    };

    readonly prompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> => {
        if (this.#turn.running) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        switch (this.#sessionLoad.kind) {
            case "not-requested":
                break;
            case "loaded":
                this.#sessionLoad = { kind: "not-requested" };
                break;
            case "capturing":
                throw new AcpExecutionError("Session history is still loading", {}, "session_busy");
            default: {
                const unexpected: never = this.#sessionLoad;
                throw new Error(`Unexpected Session load state: ${JSON.stringify(unexpected)}`);
            }
        }
        const prompt = this.buildPrompt(options);
        if (this.#sessionTitle === null || this.#sessionTitle.length === 0) {
            this.#sessionTitle = truncate(options.prompt, 500);
        }
        this.#store.write(
            new AcpStoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#updates.sessionId(),
                this.#cwd,
                this.#additionalDirectories,
                true,
                this.#sessionTitle,
                new Date().toISOString(),
                this.#lastTerminalCommandId,
            ),
        );
        this.#prompted = true;
        const running = new RunningAcpTurn(
            options.commandId,
            options.onActivity,
            options.onNarration,
            options.onText,
            this.prepareAgentContent,
        );
        this.#turn = running;
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
            await running.activities.finish();
            let result: AcpPromptResult;
            try {
                result = decodeAgentPromptResponse(response);
            } catch (cause) {
                throw new AcpExecutionError(
                    "ACP agent returned an invalid prompt response",
                    { cause },
                    "acp_invalid_prompt_response",
                );
            }
            const failure = readAcpSessionFailure(response);
            if (failure !== null) {
                await running.activities.recordNotice(failure.id, failure.revision, failure.severity, failure.title);
            }
            if (result.usage != null || result._meta?.quota !== undefined) {
                await this.#getObserver().onUsage({
                    _meta: result._meta ?? null,
                    commandId: options.commandId,
                    kind: SESSION_USAGE_UPDATED_KIND,
                    sessionId: this.#mobiusSessionId,
                    source: "prompt",
                    usage: result.usage ?? null,
                });
            }
            this.#lastTerminalCommandId = options.commandId;
            this.#store.write(
                new AcpStoredSession(
                    this.#mobiusSessionId,
                    this.#agentId,
                    this.#updates.sessionId(),
                    this.#cwd,
                    this.#additionalDirectories,
                    true,
                    this.#sessionTitle ?? "",
                    new Date().toISOString(),
                    this.#lastTerminalCommandId,
                ),
            );
            return result;
        } catch (error) {
            await running.activities.finish();
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError("ACP agent execution failed", {
                cause: error,
            });
        } finally {
            this.#turn = new IdleAcpTurn();
        }
    };

    readonly steer = async (options: AcpSteerOptions): Promise<string> => {
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
    };

    readonly cancel = async (): Promise<void> => {
        const capturedProcesses = await this.#connection.captureProcessTree();
        try {
            await this.#interactions.cancelPendingInteractions();
            if (this.#turn.running) {
                await this.#connection.connection.agent.notify(methods.agent.session.cancel, {
                    sessionId: this.#updates.sessionId(),
                });
            }
        } finally {
            await this.closeProcess(capturedProcesses);
        }
    };

    readonly respondPermission = (options: AcpPermissionResponseOptions) =>
        this.#interactions.respondPermission(options);
    readonly respondElicitation = (options: AcpElicitationResponseOptions) =>
        this.#interactions.respondElicitation(options);
    readonly onPermission = (request: RequestPermissionRequest, signal: AbortSignal) =>
        this.#interactions.onPermission(request, signal);
    readonly onElicitation = (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => this.#interactions.onElicitation(request, signal);
    readonly onElicitationComplete = (notification: CompleteElicitationNotification) =>
        this.#interactions.onElicitationComplete(notification);

    readonly onUpdate = (notification: SessionNotification): Promise<void> => this.#updates.receive(notification);

    readonly selectNativeSession = (sessionId: string): void => {
        this.#updates.select(sessionId);
        this.#nativeHistoryOwnership = { kind: "agent-owned" };
    };

    readonly #processUpdate = async (notification: SessionNotification): Promise<void> => {
        this.assertNativeSession(notification.sessionId);
        const update = notification.update;
        const rawUpdate = decodeAcpSessionUpdateV2(JSON.stringify(update));
        if (this.#sessionLoad.kind === "capturing") {
            await this.#sessionLoad.history.record(update, rawUpdate);
        } else {
            const onAcpUpdate = this.#getObserver().onAcpUpdate;
            if (onAcpUpdate !== undefined) {
                await onAcpUpdate(this.#mobiusSessionId, rawUpdate);
            }
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
        if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "text") {
                if (isProgressMessage(update)) {
                    await this.#turn.activities.recordNarrative(
                        "progress",
                        update.messageId ?? "current",
                        update.content.text,
                    );
                } else {
                    await this.#turn.activities.finishNarrative();
                    await this.#turn.onText(update.content.text, truncate(update.messageId ?? "", 255));
                }
            } else {
                await this.#turn.activities.finishNarrative();
                await this.emitAgentContent(
                    normalizeContentBlock(update.content),
                    truncate(update.messageId ?? "", 255),
                );
            }
            return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type === "text") {
                await this.#turn.activities.recordNarrative(
                    "reasoning",
                    update.messageId ?? "current",
                    update.content.text,
                );
            }
            return;
        }
        if (update.sessionUpdate === "tool_call") {
            await this.#turn.activities.recordToolCall(update);
            return;
        }
        if (update.sessionUpdate === "tool_call_update") {
            await this.#turn.activities.recordToolCallUpdate(update);
            return;
        }
        if (update.sessionUpdate === "plan") {
            await this.#turn.activities.recordPlan(update);
            return;
        }
        if (update.sessionUpdate === "plan_update") {
            await this.#turn.activities.recordPlanUpdate(update);
            return;
        }
        if (update.sessionUpdate === "plan_removed") {
            await this.#turn.activities.removePlan(update);
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
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "current_mode_update") {
            this.#configOptions = this.#configOptions.map((option) =>
                option.category === "mode" ? { ...option, currentValue: update.currentModeId } : option,
            );
            this.#configRevision += 1;
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "session_info_update") {
            const failure = readAcpSessionFailure(update);
            if (failure !== null && this.#turn.running) {
                await this.#turn.activities.recordNotice(failure.id, failure.revision, failure.severity, failure.title);
            }
            if (Object.hasOwn(update, "title")) {
                this.#sessionTitle = truncate(update.title ?? "", 500);
            }
            if (Object.hasOwn(update, "updatedAt")) {
                this.#sessionUpdatedAt = truncate(update.updatedAt ?? "", 128);
            }
            if (this.#updates.sessionId().length > 0) {
                this.#store.write(
                    new AcpStoredSession(
                        this.#mobiusSessionId,
                        this.#agentId,
                        this.#updates.sessionId(),
                        this.#cwd,
                        this.#additionalDirectories,
                        this.#prompted,
                        this.#sessionTitle ?? "",
                        new Date().toISOString(),
                        this.#lastTerminalCommandId,
                    ),
                );
            }
            await this.#getObserver().onInfo({
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
                title: this.#sessionTitle,
                updatedAt: this.#sessionUpdatedAt,
            });
            return;
        }
        if (update.sessionUpdate === "usage_update") {
            await this.#getObserver().onUsage({
                costAmount: update.cost?.amount ?? 0,
                costCurrency: truncate(update.cost?.currency ?? "", 16),
                hasCost: update.cost !== undefined && update.cost !== null,
                kind: SESSION_USAGE_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
                size: Math.max(0, Math.trunc(update.size)),
                source: "context",
                used: Math.max(0, Math.trunc(update.used)),
            });
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

    readonly closeProcess = (capturedProcesses: readonly ProcessTreeIdentity[] = []): Promise<void> =>
        this.#connection.closeProcess(capturedProcesses);
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        this.#connection.race(operation, exitMessage, signal);

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
