import {
    type AgentApp,
    type AgentConnection,
    type ContentBlock,
    agent as createAgentApp,
    methods,
    PROTOCOL_VERSION,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../../util/process/executable.ts";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointOptions,
} from "../../agent/in-process-endpoint.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import {
    threadForkResponseSchema,
    threadListResponseSchema,
    threadResumeResponseSchema,
    threadStartResponseSchema,
} from "./app-server-protocol.ts";
import { CodexBorrowedAcpAgent } from "./borrowed-agent.ts";
import { replayCodexHistory } from "./history.ts";
import { CodexOwnedAcpAgent } from "./owned-agent.ts";
import type { CodexSessionAgent } from "./session-agent.ts";
import { CodexSettings } from "./settings.ts";

const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
const CODEX_AGENT_VERSION = "0.154.0";
// Listing a directory must answer promptly: it is an interactive browser request, not a turn.
const SESSION_LIST_TIMEOUT_MILLISECONDS = 30_000;

/** Converts ACP prompt content into the app-server's `UserInput` list. */
function promptInput(prompt: readonly ContentBlock[]): readonly unknown[] {
    const input: unknown[] = [];
    for (const block of prompt) {
        if (block.type === "text") {
            input.push({ text: block.text, text_elements: [], type: "text" });
            continue;
        }
        if (block.type === "image") {
            input.push({ type: "image", url: `data:${block.mimeType};base64,${block.data}` });
            continue;
        }
        if (block.type === "resource") {
            const resource = block.resource;
            input.push({
                text: "text" in resource ? (resource.text ?? "") : "",
                text_elements: [],
                type: "text",
            });
            continue;
        }
        if (block.type === "resource_link") {
            input.push({ text: `Resource: ${block.uri}`, text_elements: [], type: "text" });
        }
    }
    return input;
}

/** True when the prompt is exactly the manual compaction slash command. */
function isCompactCommand(prompt: readonly ContentBlock[]): boolean {
    return prompt.length === 1 && prompt[0]?.type === "text" && prompt[0].text.trim().toLowerCase() === "/compact";
}

/**
 * One in-process Codex ACP agent: an ACP `AgentApp` bound to one `codex app-server` child process.
 * Mobius connects its normal ACP client to this app in-process, so every ACP behavior the daemon
 * relies on is produced here instead of by an adapter child process.
 *
 * Owns the transport and common ACP registration. Session operations are delegated to an owned
 * agent for direct turns, or a borrowed agent after resume fails and queue attachment succeeds.
 */
export class CodexAcpAgent implements InProcessAcpEndpoint {
    readonly #app: AgentApp;
    readonly #appServer: CodexAppServerClient;
    readonly terminated: Promise<AcpEndpointTermination>;
    #closePromise: Promise<void> | null = null;
    #connection: AgentConnection | null = null;
    readonly #settings: CodexSettings;
    readonly #onSessionUpdate: (notification: SessionNotification) => Promise<void>;
    readonly #onBackgroundActivity: InProcessAcpEndpointOptions["onBackgroundActivity"];
    #nativeSessionId = "";
    #sessionAgent: CodexSessionAgent;

    constructor(options: InProcessAcpEndpointOptions) {
        this.#onSessionUpdate = options.onSessionUpdate;
        this.#onBackgroundActivity = options.onBackgroundActivity;
        this.#appServer = new CodexAppServerClient({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            handlers: {
                onNotification: async (method, params) => {
                    await this.#sessionAgent.onNotification(method, params);
                },
                onServerRequest: async (request) => {
                    await this.#sessionAgent.onServerRequest(request);
                },
            },
        });
        this.#settings = new CodexSettings(this.#appServer, options.environment);
        this.#sessionAgent = new CodexOwnedAcpAgent({
            client: this.#appServer,
            settings: this.#settings,
            threadId: () => this.#nativeSessionId,
            connection: () => this.#connection,
            emit: this.#emit,
            onBackgroundActivity: (active) => {
                // Closure owns the final release after process cleanup. Queued native
                // items must not reacquire activity once that cleanup has started.
                if (this.#closePromise === null) {
                    this.#onBackgroundActivity?.(active);
                }
            },
            close: this.close,
        });
        this.terminated = this.#appServer.terminated;
        void this.terminated.then((termination) => {
            this.#sessionAgent.onTerminated(termination);
            if (termination.kind === "failed") {
                void this.close().catch((cause: unknown) => {
                    console.error("The failed Codex endpoint could not release its process tree", cause);
                });
            }
        });
        this.#app = createAgentApp({ name: "mobius-codex" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            // Declare only what this Agent actually serves. Mobius gates every request on these bits,
            // so an optimistic bit here becomes an unsupported ACP call at the far end.
            .onRequest(methods.agent.initialize, async () => ({
                _meta: { steering: { supported: true } },
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { embeddedContext: true, image: true },
                    sessionCapabilities: { close: {}, fork: {}, list: {} },
                },
                agentInfo: { name: "Codex", version: CODEX_AGENT_VERSION },
                authMethods: [],
                protocolVersion: PROTOCOL_VERSION,
            }))
            .onRequest(methods.agent.session.new, async (context) => {
                // Sandbox and approval policy stay with Codex's own configuration. Mobius reports the
                // session it was given instead of imposing policy the user did not ask for.
                const created = threadStartResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/start",
                        { cwd: context.params.cwd },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#nativeSessionId = created.thread.id;
                this.#settings.selectNewThread(created);
                await this.#settings.probeCollaborationMode(this.#nativeSessionId, context.signal);
                this.#advertiseCompactCommand();
                // The settings Mobius discovers come from this response. Without them the Run
                // settings panel has nothing to render and saved selections cannot be re-applied.
                return { configOptions: this.#settings.configOptions(), sessionId: created.thread.id };
            })
            .onRequest(methods.agent.session.setConfigOption, async (context) => {
                this.#settings.applySelection(context.params.configId, context.params.value);
                return { configOptions: this.#settings.configOptions() };
            })
            // Mobius routes a `category: "mode"` selection here rather than through
            // set_config_option, so the mode needs its own entry point.
            .onRequest(methods.agent.session.setMode, async (context) => {
                this.#settings.applySelection("mode", context.params.modeId);
                return {};
            })
            .onRequest(methods.agent.session.load, async (context) => {
                await this.#resume(context.params.sessionId, context.params.cwd, context.signal);
                await this.#replaySavedHistory(context.signal);
                this.#advertiseCompactCommand();
                return {
                    _meta: { steering: { supported: this.#sessionAgent.steeringSupported } },
                    configOptions: this.#settings.configOptions(),
                };
            })
            .onRequest(methods.agent.session.fork, async (context) => {
                const forked = threadForkResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/fork",
                        {
                            cwd: context.params.cwd,
                            // Fork keeps the native context; its response only needs the new identity
                            // and settings. History is read through the separate history boundary.
                            excludeTurns: true,
                            threadId: context.params.sessionId,
                        },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#nativeSessionId = forked.thread.id;
                this.#settings.selectRestoredThread(forked);
                await this.#settings.probeCollaborationMode(this.#nativeSessionId, context.signal);
                this.#advertiseCompactCommand();
                return { configOptions: this.#settings.configOptions(), sessionId: forked.thread.id };
            })
            .onRequest(methods.agent.session.resume, async (context) => {
                await this.#resume(context.params.sessionId, context.params.cwd, context.signal);
                this.#advertiseCompactCommand();
                return {
                    _meta: { steering: { supported: this.#sessionAgent.steeringSupported } },
                    configOptions: this.#settings.configOptions(),
                };
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                if (isCompactCommand(context.params.prompt)) {
                    return await this.#sessionAgent.compact(context.signal);
                }
                return await this.#sessionAgent.prompt(promptInput(context.params.prompt), context.signal);
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => await this.#sessionAgent.steer(context.params, context.signal),
            )
            .onRequest(methods.agent.session.list, async (context) => {
                const decoded = threadListResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/list",
                        {
                            cursor: context.params.cursor ?? null,
                            // Codex defaults to interactive sources and otherwise hides exec handoffs.
                            sourceKinds: ["cli", "vscode", "exec", "appServer"],
                        },
                        AbortSignal.any([context.signal, AbortSignal.timeout(SESSION_LIST_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                return {
                    nextCursor: decoded.nextCursor ?? null,
                    sessions: decoded.data.map((thread) => ({
                        additionalDirectories: [],
                        cwd: thread.cwd,
                        sessionId: thread.id,
                        title: thread.name ?? thread.preview ?? null,
                        updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
                    })),
                };
            })
            .onRequest(methods.agent.session.close, async () => {
                await this.#sessionAgent.cancel();
            })
            .onNotification(methods.agent.session.cancel, async () => {
                await this.#sessionAgent.cancel();
            });
    }

    readonly agentSettingsModelEffort = () => this.#settings.agentModelEffort();

    /** The ACP agent app Mobius connects its own ACP client to, in-process. */
    readonly app = (): AgentApp => this.#app;
    readonly nativeTurnId = (): string | null => this.#sessionAgent.nativeTurnId();

    /** Starts the app-server, performs its handshake, and reads the model catalog Codex offers. */
    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.#appServer.initialize(signal);
        await this.#settings.loadModels(signal);
    };

    /**
     * Releases the app-server and every process it started. Mirrors the adapter path's teardown so a
     * cancelled or closed session cannot leak the tool subprocesses running under the app-server.
     */
    readonly close = (): Promise<void> => {
        if (this.#closePromise === null) {
            // Publish closure immediately, but keep stdio intact until the process tree is captured.
            this.#appServer.detach();
            this.#closePromise = (async () => {
                await this.#sessionAgent.close();
                const child = this.#appServer.child();
                try {
                    const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
                    await stopProcessTree(child, captured);
                } finally {
                    this.#connection?.close();
                    this.#onBackgroundActivity?.(false);
                }
            })();
        }
        return this.#closePromise;
    };

    readonly #resume = async (threadId: string, cwd: string, signal: AbortSignal): Promise<void> => {
        const resumed = await (async () => {
            try {
                return threadResumeResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/resume",
                        { cwd, excludeTurns: true, threadId },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
            } catch (cause: unknown) {
                signal.throwIfAborted();
                console.warn("Codex thread resume failed; attempting borrowed queue access", { threadId }, cause);
                return null;
            }
        })();
        if (resumed === null) {
            const saved = z
                .object({
                    thread: z.object({
                        id: z.literal(threadId),
                        model: z.string().nullish(),
                        reasoningEffort: z.string().nullish(),
                        turns: z.array(z.unknown()),
                    }),
                })
                .parse(
                    await this.#appServer.request(
                        "thread/read",
                        { threadId, includeTurns: false },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
            const queued = new CodexBorrowedAcpAgent(this.#appServer, threadId, this.#emit);
            await queued.initialize(signal);
            this.#nativeSessionId = threadId;
            this.#settings.selectRestoredThread({
                thread: { id: threadId },
                model: saved.thread.model,
                reasoningEffort: saved.thread.reasoningEffort,
            });
            await this.#sessionAgent.close();
            this.#sessionAgent = queued;
            return;
        }
        this.#nativeSessionId = resumed.thread.id;
        this.#settings.selectRestoredThread(resumed);
        await this.#settings.probeCollaborationMode(this.#nativeSessionId, signal);
    };

    // ACP load requires chronological replay. Resume only restores execution;
    // native pages supply history without a single full-transcript response.
    readonly #replaySavedHistory = async (signal: AbortSignal): Promise<void> => {
        await replayCodexHistory(this.#appServer, this.#nativeSessionId, this.#emit, signal);
    };

    /** Announces the manual compact command after every session entry point —
     *  new, load, resume, and fork — so clients on restored sessions discover
     *  it too. Deferred past the session response so the notification follows
     *  session establishment rather than racing it. */
    readonly #advertiseCompactCommand = (): void => {
        setTimeout(() => {
            void this.#emit({
                availableCommands: [
                    {
                        description: "Manually compact the session context",
                        name: "compact",
                    },
                ],
                sessionUpdate: "available_commands_update",
            }).catch((cause: unknown) => {
                console.error("Codex available commands notification failed", cause);
            });
        }, 0);
    };

    readonly #emit = async (update: SessionNotification["update"]): Promise<void> => {
        const connection = this.#connection;
        if (connection === null || this.#nativeSessionId.length === 0) {
            return;
        }
        await this.#onSessionUpdate({
            sessionId: this.#nativeSessionId,
            update,
        });
    };
}
