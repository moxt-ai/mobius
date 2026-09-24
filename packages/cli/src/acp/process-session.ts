import { spawn } from "node:child_process";
import {
    type ClientConnection,
    type CompleteElicitationNotification,
    type ContentBlock,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    RequestError,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
    AGENT_CONTENT_KIND,
    type AgentContentEvent,
    type AgentDisplayContent,
    type AgentPromptResponse,
    decodeAgentPromptResponse,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionCommandsUpdatedEvent,
    type SessionConfigOption,
    type SessionConfigUpdatedEvent,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionPermissionOption,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import type { LocalRasterImage } from "../authorization/local-raster.ts";
import { readInlineRaster, readLocalRaster } from "../authorization/local-raster.ts";
import { type LocalVideo, readInlineVideo } from "../authorization/local-video.ts";
import type { AcpAgentDefinition } from "../config.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../infra/operation-metrics.ts";
import { embedLocalHistoryImages } from "../native-sessions/history-images.ts";
import {
    captureProcessTree,
    type ProcessTreeIdentity,
    revalidateExecutable,
    stopProcessTree,
} from "../process/executable.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";
import {
    type AcpActivity,
    type AcpActivityNarration,
    imageDisplayContent,
    isProgressMessage,
    normalizeContentBlock,
} from "./activity.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";
import { normalizeElicitationFields, validateElicitationContent } from "./elicitation.ts";
import {
    type AcpEndpointTermination,
    acpEndpointTerminationError,
    type InProcessAcpEndpoint,
} from "./in-process/acp-endpoint.ts";
import {
    type NativeSessionOrigin,
    type NativeSessionPage,
    nativeSessionIdSchema,
    nativeSessionPageSchema,
} from "./native-session.ts";
import { normalizeAcpCapabilities, unsupportedSessionCapabilities } from "./session-capabilities.ts";
import { type SessionConfigProtocol, SessionConfigProtocolError } from "./session-config/session-config-protocol.ts";
import { sessionConfigProtocolForAgent } from "./session-config/session-config-registry.ts";
import { AcpHistoryReplay } from "./session-history.ts";
import {
    type AcpTurnState,
    IdleAcpTurn,
    PendingElicitation,
    PendingPermission,
    RunningAcpTurn,
} from "./session-state.ts";
import {
    type AcpSessionStore,
    AcpStoredSession,
    DeletedAcpStoredSession,
    FoundAcpStoredSession,
} from "./session-store.ts";
import { isRecord, readString, truncate } from "./value-utils.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;
const MAX_PRE_SESSION_UPDATES = 100;
const MAX_PRE_SESSION_UPDATE_BYTES = 1024 * 1024;

export interface AcpPrepareOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly origin?: NativeSessionOrigin;
}

export interface AcpNativeHistoryReader {
    readonly read: (options: AcpPrepareOptions, nativeSessionId: string) => Promise<NativeSessionHistory | null>;
}

export interface AcpAgentSettingsInspectionOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export interface AcpConfigureOptions extends AcpPrepareOptions {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly requestId: string;
    readonly value: string;
    readonly valueType: SessionConfigOption["type"];
}

interface AcpPromptContentOptions {
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
}

export interface AcpTurnOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly commandId: string;
    readonly disposition?: string;
    readonly onActivity: (activity: AcpActivity) => Promise<void>;
    /**
     * Receives streamed narration increments. Optional: without a sink the same text
     * still arrives once on the completed activity snapshot, just without live updates.
     */
    readonly onNarration?: (narration: AcpActivityNarration) => Promise<void>;
    readonly onText: (text: string, messageId: string) => Promise<void>;
    readonly targetCommandId?: string;
}

export interface AcpSteerOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly commandId: string;
    readonly targetCommandId: string;
}

export interface AcpPermissionResponseOptions {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: SessionPermissionResolvedEvent["outcome"];
    readonly sessionId: string;
}

export interface AcpElicitationResponseOptions {
    readonly action: SessionElicitationResolvedEvent["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}

export type AcpPromptResult = AgentPromptResponse;

export interface AcpSessionObserver {
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onContent: (event: AgentContentEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
    readonly onUsage: (event: SessionUsageUpdatedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onContent = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
    readonly onUsage = (): Promise<void> => Promise.resolve();
}

export class AcpPreparedSession {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly restored: boolean;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        restored: boolean,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.restored = restored;
    }
}

export class AcpAgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];

    constructor(agentName: string, agentVersion: string, configOptions: readonly SessionConfigOption[]) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
    }
}

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";

class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

function readableWebStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    let streamOpen = true;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!streamOpen) {
                    return;
                }
                if (chunk instanceof Uint8Array) {
                    controller.enqueue(new Uint8Array(chunk));
                    return;
                }
                streamOpen = false;
                controller.error(new Error("ACP process produced a non-binary chunk"));
            });
            input.once("end", () => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.close();
            });
            input.once("error", (error) => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.error(error);
            });
        },
        cancel() {
            streamOpen = false;
        },
    });
}

export function createWritableAcpStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    let outputFailure: unknown;
    const pendingWriteFailures = new Set<(error: unknown) => void>();
    const fail = (error: unknown): void => {
        outputFailure = error;
        for (const reject of pendingWriteFailures) {
            reject(error);
        }
        pendingWriteFailures.clear();
    };
    output.on("error", fail);
    output.once("close", () => {
        if (outputFailure === undefined) {
            fail(new Error("ACP process input closed"));
        }
    });
    return new WritableStream<Uint8Array>({
        write(chunk) {
            if (outputFailure !== undefined) {
                return Promise.reject(outputFailure);
            }
            return new Promise<void>((resolve, reject) => {
                pendingWriteFailures.add(reject);
                output.write(chunk, (error) => {
                    pendingWriteFailures.delete(reject);
                    if (error) {
                        outputFailure = error;
                        reject(error);
                        return;
                    }
                    if (outputFailure !== undefined) {
                        reject(outputFailure);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length && leftEntries.every(([name, value]) => right[name] === value);
}

export class AcpProcessSession implements AcpClientHandler {
    readonly #additionalDirectories: readonly string[];
    readonly #acceptedUrlElicitations = new Map<string, string>();
    readonly #agentId: string;
    readonly #connection: ClientConnection;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => AcpSessionObserver;
    readonly #inProcessAgent: InProcessAcpEndpoint | null;
    #mobiusSessionId: string;
    readonly #pendingElicitations = new Map<string, PendingElicitation>();
    readonly #pendingPermissions = new Map<string, PendingPermission>();
    readonly #preSessionUpdates: SessionNotification[] = [];
    // Both topologies report a terminal outcome, even after a prompt's initial RPC is acknowledged.
    readonly #termination: Promise<AcpEndpointTermination>;
    readonly #runtimeChild: ReturnType<typeof spawn> | null;
    readonly #metrics: OperationMetrics;
    readonly #sessionConfigProtocol: SessionConfigProtocol;
    readonly #store: AcpSessionStore;
    readonly #verifiedAgentVersion: string;
    #preSessionUpdateBytes = 0;
    #agentName = "";
    #agentVersion = "";
    #bufferedAgentText: readonly { readonly chunks: readonly string[]; readonly messageId: string }[] = [];
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    #configRevision = 0;
    #configOptions: readonly SessionConfigOption[] = [];
    #nativeSessionId = "";
    #prompted = false;
    #replay: { readonly kind: "idle" | "discard" } | { readonly kind: "capture"; readonly history: AcpHistoryReplay } =
        {
            kind: "idle",
        };
    #restored = false;
    #sessionTitle: string | null = null;
    #sessionUpdatedAt = "";
    #turn: AcpTurnState = new IdleAcpTurn();
    #updateTail: Promise<void> = Promise.resolve();

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        additionalDirectories: readonly string[],
        mobiusSessionId: string,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        metrics: OperationMetrics,
    ) {
        this.#additionalDirectories = [...additionalDirectories];
        this.#agentId = agent.id;
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#getObserver = getObserver;
        this.#mobiusSessionId = mobiusSessionId;
        this.#metrics = metrics;
        this.#sessionConfigProtocol = sessionConfigProtocolForAgent(agent.id);
        this.#store = store;
        this.#verifiedAgentVersion = agent.agentVersion;
        if (agent.kind === "in-process-acp") {
            // Mobius hosts the ACP Agent in-process and drives the vendor's own protocol, so there is
            // no adapter process to spawn or supervise here. The endpoint owns its own resources.
            const inProcess = agent.createEndpoint({
                command: agent.command,
                cwd,
                environment: agent.environment,
            });
            this.#inProcessAgent = inProcess;
            this.#runtimeChild = null;
            this.#termination = inProcess.terminated;
            this.#connection = createAcpClient(this).connect(inProcess.app());
            return;
        }
        this.#inProcessAgent = null;
        const child = spawn(agent.adapterPath, [...agent.arguments], {
            cwd,
            detached: process.platform !== "win32",
            env: { ...process.env, ...agent.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.#runtimeChild = child;
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (stdin === null || stdout === null || stderr === null) {
            child.kill("SIGKILL");
            throw new AcpExecutionError("ACP process streams are unavailable");
        }
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
            process.stderr.write(`[${agent.id}-acp] ${chunk}`);
        });
        this.#termination = new Promise<AcpEndpointTermination>((resolve) => {
            child.once("error", (cause) => {
                resolve({ kind: "failed", error: new AcpExecutionError("The ACP process could not run", { cause }) });
            });
            child.once("exit", (code, signal) => {
                resolve({
                    kind: "failed",
                    error: new AcpExecutionError("The ACP process stopped", { cause: { code, signal } }),
                });
            });
        });
        const stream = ndJsonStream(createWritableAcpStream(stdin), readableWebStream(stdout));
        this.#connection = createAcpClient(this).connect(stream);
    }

    static async #start(
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        initialize: (runtime: AcpProcessSession) => Promise<void>,
        metrics: OperationMetrics,
    ): Promise<AcpProcessSession> {
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
                    new AcpProcessSession(
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
    ): Promise<AcpProcessSession> =>
        await AcpProcessSession.#start(
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
    ): Promise<AcpProcessSession> =>
        await AcpProcessSession.#start(
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
        const history = new AcpHistoryReplay();
        this.#replay = { kind: "capture", history };
        try {
            await this.race(
                this.#connection.agent.request(
                    methods.agent.session.load,
                    {
                        additionalDirectories: [...this.#additionalDirectories],
                        cwd: this.#cwd,
                        mcpServers: [],
                        sessionId: this.#nativeSessionId,
                    },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while loading history",
                signal,
            );
            await this.#updateTail;
            signal.throwIfAborted();
            return await embedLocalHistoryImages(await history.snapshot(), signal);
        } finally {
            this.#replay = { kind: "idle" };
        }
    };

    private readonly emitAgentMessage = async (chunks: readonly string[], messageId: string): Promise<void> => {
        for (const chunk of chunks) {
            await this.#turn.onText(chunk, messageId);
        }
    };

    private readonly bufferAgentText = async (text: string, messageId: string): Promise<void> => {
        const previous = this.#bufferedAgentText.at(-1);
        if (previous?.messageId === messageId) {
            this.#bufferedAgentText = [
                ...this.#bufferedAgentText.slice(0, -1),
                { chunks: [...previous.chunks, text], messageId },
            ];
            return;
        }
        this.#bufferedAgentText = [...this.#bufferedAgentText, { chunks: [text], messageId }];
    };

    private readonly flushAgentText = async (): Promise<void> => {
        const buffered = this.#bufferedAgentText;
        this.#bufferedAgentText = [];
        for (const message of buffered) {
            await this.emitAgentMessage(message.chunks, message.messageId);
        }
    };

    private readonly recordBufferedAgentTextAsProgress = async (): Promise<void> => {
        const buffered = this.#bufferedAgentText;
        this.#bufferedAgentText = [];
        for (const message of buffered) {
            for (const chunk of message.chunks) {
                await this.#turn.activities.recordNarrative("progress", message.messageId, chunk);
            }
        }
    };

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
        if (this.#inProcessAgent !== null) {
            // The ACP agent runs in this process, but it still owns an app-server child that must
            // start and complete its own handshake before the ACP conversation can begin.
            await this.race(
                this.#inProcessAgent.initialize(signal),
                "The Codex app-server exited during initialization",
                signal,
            ).catch((cause: unknown) => {
                signal.throwIfAborted();
                throw new RetryableAcpInitializationError(cause);
            });
        }
        const initialized = await this.race(
            this.#connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {
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
                        this.#connection.agent.request(
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
                this.#nativeSessionId === origin.nativeSessionId ||
                this.#store.findNative(this.#agentId, this.#nativeSessionId).length > 0
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
            this.#sessionTitle = stored.session.title;
            this.#restored = true;
            if (this.#capabilities.resumeSession) {
                lifecycleResponse = await this.#metrics.measure(
                    "session-resume",
                    async () =>
                        await this.race(
                            this.#connection.agent.request(
                                methods.agent.session.resume,
                                {
                                    additionalDirectories: [...this.#additionalDirectories],
                                    cwd: this.#cwd,
                                    mcpServers: [],
                                    sessionId: this.#nativeSessionId,
                                },
                                { cancellationSignal: signal },
                            ),
                            "ACP agent exited while resuming a session",
                            signal,
                        ),
                );
            } else if (this.#capabilities.loadSession) {
                this.#replay = { kind: "discard" };
                try {
                    lifecycleResponse = await this.#metrics.measure(
                        "session-load",
                        async () =>
                            await this.race(
                                this.#connection.agent.request(
                                    methods.agent.session.load,
                                    {
                                        additionalDirectories: [...this.#additionalDirectories],
                                        cwd: this.#cwd,
                                        mcpServers: [],
                                        sessionId: this.#nativeSessionId,
                                    },
                                    { cancellationSignal: signal },
                                ),
                                "ACP agent exited while loading a session",
                                signal,
                            ),
                    );
                } finally {
                    await this.#updateTail;
                    this.#replay = { kind: "idle" };
                }
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
                        this.#connection.agent.request(
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
            lifecycleResponse = created;
        }
        this.#configOptions = this.#sessionConfigProtocol.normalizeLifecycle(lifecycleResponse);
        await this.#updateTail;
        signal.throwIfAborted();
        this.#store.write(
            new AcpStoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#nativeSessionId,
                this.#cwd,
                this.#additionalDirectories,
                this.#prompted,
                this.#sessionTitle ?? "",
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
            this.#connection.agent.request(methods.agent.session.list, cursor === null ? {} : { cursor }, {
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
            this.#connection.agent.request(
                methods.agent.session.delete,
                { sessionId: nativeSessionIdSchema.parse(nativeSessionId) },
                { cancellationSignal: signal },
            ),
            "ACP agent exited while deleting a session",
            signal,
        );
    };

    readonly nativeSessionId = (): string => this.#nativeSessionId;

    readonly adoptNativeSessionId = (sessionId: string): void => {
        if (this.#prompted || this.#nativeSessionId !== sessionId) {
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
                this.#nativeSessionId,
                {
                    request: async (method, params, failureMessage, signal) =>
                        await this.race(
                            this.#connection.agent.request(method, params, {
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
            await this.#updateTail;
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

    readonly prompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> => {
        if (this.#turn.running) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const prompt = this.buildPrompt(options);
        if (this.#sessionTitle === null || this.#sessionTitle.length === 0) {
            this.#sessionTitle = truncate(options.prompt, 500);
        }
        this.#store.write(
            new AcpStoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#nativeSessionId,
                this.#cwd,
                this.#additionalDirectories,
                true,
                this.#sessionTitle,
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
        try {
            const response: unknown = await this.race(
                this.#connection.agent.request(
                    methods.agent.session.prompt,
                    { prompt, sessionId: this.#nativeSessionId },
                    { cancellationSignal: options.signal },
                ),
                "ACP agent exited during a prompt",
                options.signal,
            );
            await this.#updateTail;
            await this.flushAgentText();
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
            this.#bufferedAgentText = [];
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
            this.#connection.agent.request("_session/steering", {
                _meta: { steering: { idleBehavior: "promptRequired" } },
                prompt,
                sessionId: this.#nativeSessionId,
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
        const capturedProcesses = this.#runtimeChild === null ? [] : await captureProcessTree(this.#runtimeChild);
        try {
            await this.cancelPendingInteractions();
            if (this.#turn.running) {
                await this.#connection.agent.notify(methods.agent.session.cancel, {
                    sessionId: this.#nativeSessionId,
                });
            }
        } finally {
            await this.closeProcess(capturedProcesses);
        }
    };

    readonly respondPermission = async (options: AcpPermissionResponseOptions): Promise<void> => {
        const pending = this.#pendingPermissions.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The permission request is no longer active",
                {},
                "permission_request_not_found",
            );
        }
        if (options.outcome === "selected" && !pending.optionIds.has(options.optionId)) {
            throw new AcpExecutionError(
                "The selected permission option is unavailable",
                {},
                "invalid_permission_response",
            );
        }
        const resolved = options.outcome === "selected" ? pending.select(options.optionId) : pending.cancel();
        if (!resolved) {
            throw new AcpExecutionError(
                "The permission request was already resolved",
                {},
                "permission_request_not_found",
            );
        }
        this.#pendingPermissions.delete(options.interactionId);
        await this.#getObserver().onPermissionResolved({
            interactionId: options.interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: options.outcome === "selected" ? options.optionId : "",
            outcome: options.outcome,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly respondElicitation = async (options: AcpElicitationResponseOptions): Promise<void> => {
        const pending = this.#pendingElicitations.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The elicitation request is no longer active",
                {},
                "elicitation_request_not_found",
            );
        }
        let resolved = false;
        if (options.action === "accept") {
            if (pending.elicitationId.length > 0) {
                resolved = pending.accept({});
                if (resolved) {
                    this.#acceptedUrlElicitations.set(pending.elicitationId, pending.interactionId);
                }
            } else {
                resolved = pending.accept(validateElicitationContent(options.content, pending.requestedSchema));
            }
        } else if (options.action === "decline") {
            resolved = pending.decline();
        } else {
            resolved = pending.cancel();
        }
        if (!resolved) {
            throw new AcpExecutionError(
                "The elicitation request was already resolved",
                {},
                "elicitation_request_not_found",
            );
        }
        this.#pendingElicitations.delete(options.interactionId);
        await this.#getObserver().onElicitationResolved({
            action: options.action,
            interactionId: options.interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly onPermission = async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        this.assertNativeSession(request.sessionId);
        const interactionId = `permission-${crypto.randomUUID()}`;
        const options: SessionPermissionOption[] = request.options.slice(0, 20).map((option) => ({
            kind: option.kind,
            name: truncate(option.name, 255),
            optionId: truncate(option.optionId, 255),
        }));
        if (options.length === 0) {
            throw new AcpExecutionError(
                "ACP permission request did not provide any choices",
                {},
                "invalid_agent_permission_request",
            );
        }
        const pending = new PendingPermission(interactionId, new Set(options.map((option) => option.optionId)));
        this.#pendingPermissions.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelPermission(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#getObserver().onPermission({
                commandId: this.#turn.commandId,
                interactionId,
                kind: SESSION_PERMISSION_REQUESTED_KIND,
                options,
                sessionId: this.#mobiusSessionId,
                title: truncate(request.toolCall.title ?? "Permission required", 500),
                toolCallId: truncate(request.toolCall.toolCallId, 255),
                toolKind: truncate(request.toolCall.kind ?? "other", 64),
            });
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingPermissions.delete(interactionId);
        }
    };

    readonly onElicitation = async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        const sessionId = Reflect.get(request, "sessionId");
        if (typeof sessionId !== "string") {
            throw new AcpExecutionError(
                "Mobius only accepts session-scoped ACP elicitations",
                {},
                "unsupported_elicitation_scope",
            );
        }
        this.assertNativeSession(sessionId);
        if (request.mode !== "form" && request.mode !== "url") {
            throw new AcpExecutionError(
                "The ACP agent requested an unsupported elicitation mode",
                {},
                "unsupported_elicitation_mode",
            );
        }
        const interactionId = `elicitation-${crypto.randomUUID()}`;
        const schemaValue = Reflect.get(request, "requestedSchema");
        const requestedSchema = request.mode === "form" ? schemaValue : {};
        const elicitationIdValue = Reflect.get(request, "elicitationId");
        const elicitationId =
            request.mode === "url" && typeof elicitationIdValue === "string" ? truncate(elicitationIdValue, 255) : "";
        const pending = new PendingElicitation(interactionId, elicitationId, requestedSchema);
        this.#pendingElicitations.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelElicitation(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#getObserver().onElicitation({
                accepted: false,
                commandId: this.#turn.commandId,
                elicitationId,
                fields: normalizeElicitationFields(requestedSchema),
                interactionId,
                kind: SESSION_ELICITATION_REQUESTED_KIND,
                message: truncate(request.message, 2_000),
                mode: request.mode,
                sessionId: this.#mobiusSessionId,
                url:
                    request.mode === "url" && typeof Reflect.get(request, "url") === "string"
                        ? truncate(readString(Reflect.get(request, "url")), 4_096)
                        : "",
            });
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingElicitations.delete(interactionId);
        }
    };

    readonly onElicitationComplete = async (notification: CompleteElicitationNotification): Promise<void> => {
        const interactionId = this.#acceptedUrlElicitations.get(notification.elicitationId);
        if (interactionId === undefined) {
            return;
        }
        this.#acceptedUrlElicitations.delete(notification.elicitationId);
        await this.#getObserver().onElicitationResolved({
            action: "complete",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly onUpdate = (notification: SessionNotification): Promise<void> => {
        if (this.#nativeSessionId.length === 0) {
            const notificationBytes = Buffer.byteLength(JSON.stringify(notification));
            if (
                this.#preSessionUpdates.length >= MAX_PRE_SESSION_UPDATES ||
                this.#preSessionUpdateBytes + notificationBytes > MAX_PRE_SESSION_UPDATE_BYTES
            ) {
                return Promise.reject(
                    new AcpExecutionError(
                        "ACP agent sent too many updates before creating its session",
                        {},
                        "agent_update_limit",
                    ),
                );
            }
            this.#preSessionUpdates.push(notification);
            this.#preSessionUpdateBytes += notificationBytes;
            return Promise.resolve();
        }
        return this.enqueueUpdate(notification);
    };

    readonly enqueueUpdate = (notification: SessionNotification): Promise<void> => {
        this.#updateTail = this.#updateTail.then(async () => await this.processUpdate(notification));
        return this.#updateTail;
    };

    readonly selectNativeSession = (sessionId: string): void => {
        const selected = nativeSessionIdSchema.parse(sessionId);
        if (this.#nativeSessionId.length > 0 && this.#nativeSessionId !== selected) {
            throw new AcpExecutionError(
                "ACP agent attempted to replace the selected session",
                {},
                "invalid_agent_session",
            );
        }
        this.#nativeSessionId = selected;
        const pending = this.#preSessionUpdates.splice(0);
        this.#preSessionUpdateBytes = 0;
        for (const notification of pending) {
            void this.enqueueUpdate(notification);
        }
    };

    readonly processUpdate = async (notification: SessionNotification): Promise<void> => {
        this.assertNativeSession(notification.sessionId);
        const update = notification.update;
        if (this.#replay.kind === "capture") {
            await this.#replay.history.record(update);
        }
        if (
            this.#replay.kind !== "idle" &&
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
                    await this.bufferAgentText(update.content.text, truncate(update.messageId ?? "", 255));
                }
            } else {
                await this.#turn.activities.finishNarrative();
                await this.flushAgentText();
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
            await this.recordBufferedAgentTextAsProgress();
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
                commands,
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
            if (Object.hasOwn(update, "title")) {
                this.#sessionTitle = truncate(update.title ?? "", 500);
            }
            if (Object.hasOwn(update, "updatedAt")) {
                this.#sessionUpdatedAt = truncate(update.updatedAt ?? "", 128);
            }
            if (this.#nativeSessionId.length > 0) {
                this.#store.write(
                    new AcpStoredSession(
                        this.#mobiusSessionId,
                        this.#agentId,
                        this.#nativeSessionId,
                        this.#cwd,
                        this.#additionalDirectories,
                        this.#prompted,
                        this.#sessionTitle ?? "",
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
            await this.cancelPendingInteractions();
            if (this.#capabilities.closeSession && this.#nativeSessionId.length > 0) {
                try {
                    await this.#connection.agent.request(
                        methods.agent.session.close,
                        { sessionId: this.#nativeSessionId },
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

    readonly closeProcess = async (capturedProcesses: readonly ProcessTreeIdentity[] = []): Promise<void> => {
        try {
            if (this.#runtimeChild === null) {
                // The in-process agent owns its app-server child and its process tree.
                await this.#inProcessAgent?.close();
                return;
            }
            await stopProcessTree(this.#runtimeChild, capturedProcesses);
        } finally {
            this.#connection.close();
        }
    };

    readonly race = async <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> => {
        signal.throwIfAborted();
        let removeAbortListener = (): void => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = (): void => {
                reject(signal.reason ?? new Error("ACP request was cancelled"));
            };
            signal.addEventListener("abort", rejectAbort, { once: true });
            removeAbortListener = (): void => {
                signal.removeEventListener("abort", rejectAbort);
            };
        });
        try {
            try {
                return await Promise.race([
                    operation,
                    this.#termination.then((termination) => {
                        const cause = acpEndpointTerminationError(termination);
                        throw new AcpExecutionError(exitMessage, { cause }, cause.code);
                    }),
                    aborted,
                ]);
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof RequestError && error.code === -32_000) {
                    throw new AcpExecutionError(
                        "Agent authentication is required",
                        { cause: error },
                        "authentication_required",
                    );
                }
                if (error instanceof RequestError) {
                    throw new AcpExecutionError(truncate(error.message, 500), { cause: error }, "acp_agent_error");
                }
                throw error;
            }
        } finally {
            removeAbortListener();
        }
    };

    readonly assertNativeSession = (sessionId: string): void => {
        if (sessionId !== this.#nativeSessionId) {
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

    readonly cancelPermission = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingPermissions.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingPermissions.delete(interactionId);
        await this.#getObserver().onPermissionResolved({
            interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: "",
            outcome: "cancelled",
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly cancelElicitation = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingElicitations.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingElicitations.delete(interactionId);
        await this.#getObserver().onElicitationResolved({
            action: "cancel",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly cancelPendingInteractions = async (): Promise<void> => {
        const permissionIds = [...this.#pendingPermissions.keys()];
        const elicitationIds = [...this.#pendingElicitations.keys()];
        const acceptedElicitationIds = [...this.#acceptedUrlElicitations.values()];
        this.#acceptedUrlElicitations.clear();
        for (const interactionId of permissionIds) {
            await this.cancelPermission(interactionId);
        }
        for (const interactionId of elicitationIds) {
            await this.cancelElicitation(interactionId);
        }
        for (const interactionId of acceptedElicitationIds) {
            await this.#getObserver().onElicitationResolved({
                action: "cancel",
                interactionId,
                kind: SESSION_ELICITATION_RESOLVED_KIND,
                sessionId: this.#mobiusSessionId,
            });
        }
    };
}
