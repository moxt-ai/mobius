import {
    type AgentApp,
    type AgentConnection,
    type ContentBlock,
    agent as createAgentApp,
    methods,
    type PermissionOption,
    PROTOCOL_VERSION,
    type PromptResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";

import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../process/executable.ts";
import { AcpExecutionError } from "../acp-error.ts";
import {
    type AcpEndpointTermination,
    acpEndpointTerminationError,
    type InProcessAcpEndpoint,
    type InProcessAcpEndpointOptions,
} from "../in-process/acp-endpoint.ts";
import { sessionFailureMeta } from "../session-failure.ts";
import { CodexAppServerClient, type CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    commandApprovalParamsSchema,
    errorNotificationSchema,
    fileChangeApprovalParamsSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
    reasoningTextDeltaParamsSchema,
    requestUserInputParamsSchema,
    threadForkResponseSchema,
    threadListResponseSchema,
    threadResumeResponseSchema,
    threadSettingsUpdatedSchema,
    threadStartResponseSchema,
    turnNotificationSchema,
    turnSchema,
    turnSteerResponseSchema,
    type UserInputQuestion,
} from "./app-server-protocol.ts";
import { decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";
import { CodexSettings } from "./settings.ts";

const APPROVAL_REASON_CHARACTER_LIMIT = 500;
const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
const CODEX_AGENT_VERSION = "0.154.0";
// Listing a directory must answer promptly: it is an interactive browser request, not a turn.
const SESSION_LIST_TIMEOUT_MILLISECONDS = 30_000;
const CODEX_COMMANDS = Object.freeze([{ description: "Compact the conversation context", name: "compact" }]);
const COMPACT_COMPLETED_MESSAGE = "Context compacted.";

/** The choices Mobius offers when the app-server asks it to approve a local side effect. */
const APPROVAL_OPTIONS: readonly PermissionOption[] = Object.freeze([
    { kind: "allow_once", name: "Allow once", optionId: "accept" },
    { kind: "allow_always", name: "Allow for this session", optionId: "acceptForSession" },
    { kind: "reject_once", name: "Deny", optionId: "decline" },
]);

function permissionDecision(optionId: string): "accept" | "acceptForSession" | "decline" | "cancel" {
    if (optionId === "accept" || optionId === "acceptForSession" || optionId === "decline") {
        return optionId;
    }
    return "cancel";
}

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

function isCompactPrompt(prompt: readonly ContentBlock[]): boolean {
    return prompt.length === 1 && prompt[0]?.type === "text" && prompt[0].text.trim() === "/compact";
}

interface SteeringPromptBlock {
    readonly content: ContentBlock;
    readonly input: unknown;
}

function steeringPrompt(prompt: readonly unknown[]): readonly SteeringPromptBlock[] {
    const blocks: SteeringPromptBlock[] = [];
    for (const block of prompt) {
        if (typeof block !== "object" || block === null) {
            throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
        }
        const type = Reflect.get(block, "type");
        if (type === "text") {
            const text = Reflect.get(block, "text");
            if (typeof text !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({ content: { text, type: "text" }, input: { text, text_elements: [], type: "text" } });
            continue;
        }
        if (type === "image") {
            const data = Reflect.get(block, "data");
            const mimeType = Reflect.get(block, "mimeType");
            if (typeof data !== "string" || typeof mimeType !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content: { data, mimeType, type: "image" },
                input: { type: "image", url: `data:${mimeType};base64,${data}` },
            });
            continue;
        }
        if (type === "resource") {
            const resource = Reflect.get(block, "resource");
            if (typeof resource !== "object" || resource === null) {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            const uri = Reflect.get(resource, "uri");
            const text = Reflect.get(resource, "text");
            const blob = Reflect.get(resource, "blob");
            if (
                typeof uri !== "string" ||
                (typeof text !== "string" && typeof blob !== "string") ||
                (text !== undefined && typeof text !== "string") ||
                (blob !== undefined && typeof blob !== "string")
            ) {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content:
                    typeof text === "string"
                        ? { resource: { text, uri }, type: "resource" }
                        : { resource: { blob, uri }, type: "resource" },
                input: { text: text ?? "", text_elements: [], type: "text" },
            });
            continue;
        }
        if (type === "resource_link") {
            const name = Reflect.get(block, "name");
            const uri = Reflect.get(block, "uri");
            if (typeof name !== "string" || typeof uri !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content: { name, type: "resource_link", uri },
                input: { text: `Resource: ${uri}`, text_elements: [], type: "text" },
            });
            continue;
        }
        throw new AcpExecutionError("Codex received an unsupported steering prompt", {}, "invalid_request");
    }
    return blocks;
}

interface ActiveTurn {
    readonly completion: PromiseWithResolvers<PromptResponse>;
    readonly turn: { id: string };
}

function agentMessageUpdate(
    messageId: string,
    text: string,
    phase: "commentary" | "final_answer" | null | undefined,
): SessionNotification["update"] {
    return {
        content: { text, type: "text" },
        messageId,
        sessionUpdate: phase === "commentary" ? "agent_thought_chunk" : "agent_message_chunk",
    };
}

function userInputSchema(questions: readonly UserInputQuestion[]): unknown {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const question of questions) {
        required.push(question.id);
        properties[question.id] = {
            description: question.question,
            title: question.header,
            type: "string",
            ...(question.options == null || question.options.length === 0
                ? {}
                : {
                      oneOf: question.options.map((option) => ({
                          const: option.label,
                          description: option.description,
                          title: option.label,
                      })),
                  }),
        };
    }
    return { properties, required, type: "object" };
}

/**
 * One in-process Codex ACP agent: an ACP `AgentApp` bound to one `codex app-server` child process.
 * Mobius connects its normal ACP client to this app in-process, so every ACP behavior the daemon
 * relies on is produced here instead of by an adapter child process.
 *
 * Turn lifecycle: `session/prompt` maps to `turn/start`, whose response arrives before the turn
 * finishes. Completion is therefore captured from the `turn/completed` notification, and `session/
 * cancel` resolves the same completion with `stopReason: "cancelled"` so a cancelled turn never
 * waits on a notification that may not arrive.
 */
export class CodexAcpAgent implements InProcessAcpEndpoint {
    readonly #app: AgentApp;
    readonly #appServer: CodexAppServerClient;
    readonly terminated: Promise<AcpEndpointTermination>;
    #closePromise: Promise<void> | null = null;
    #connection: AgentConnection | null = null;
    readonly #settings: CodexSettings;
    #nativeSessionId = "";
    readonly #streamedReasoningItemIds = new Set<string>();
    readonly #agentMessages = new Map<
        string,
        { readonly phase: "commentary" | "final_answer" | null | undefined; readonly kind: "started" | "streaming" }
    >();
    readonly #noticeRevisions = new Map<string, number>();
    #turn: ActiveTurn | null = null;
    #nativeTurnId: string | null = null;
    #updateTail: Promise<void> = Promise.resolve();

    constructor(options: InProcessAcpEndpointOptions) {
        this.#appServer = new CodexAppServerClient({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            handlers: {
                onNotification: async (method, params) => {
                    await this.#onNotification(method, params);
                },
                onServerRequest: async (request) => {
                    await this.#onServerRequest(request);
                },
            },
        });
        this.#settings = new CodexSettings(this.#appServer, options.environment);
        this.terminated = this.#appServer.terminated;
        void this.terminated.then((termination) => {
            this.#turn?.completion.reject(acpEndpointTerminationError(termination));
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
                await this.#emitAvailableCommands();
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
                const resumed = threadResumeResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/resume",
                        { cwd: context.params.cwd, excludeTurns: false, threadId: context.params.sessionId },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#nativeSessionId = resumed.thread.id;
                this.#settings.selectRestoredThread(resumed);
                await this.#settings.probeCollaborationMode(this.#nativeSessionId, context.signal);
                await this.#replayHistory(resumed.thread.turns);
                await this.#emitAvailableCommands();
                return { configOptions: this.#settings.configOptions() };
            })
            .onRequest(methods.agent.session.fork, async (context) => {
                const forked = threadForkResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/fork",
                        {
                            cwd: context.params.cwd,
                            excludeTurns: false,
                            threadId: context.params.sessionId,
                        },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#nativeSessionId = forked.thread.id;
                this.#settings.selectRestoredThread(forked);
                await this.#settings.probeCollaborationMode(this.#nativeSessionId, context.signal);
                await this.#replayHistory(forked.thread.turns);
                await this.#emitAvailableCommands();
                return { configOptions: this.#settings.configOptions(), sessionId: forked.thread.id };
            })
            .onRequest(methods.agent.session.resume, async (context) => {
                const resumed = threadResumeResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/resume",
                        { cwd: context.params.cwd, excludeTurns: true, threadId: context.params.sessionId },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#nativeSessionId = resumed.thread.id;
                this.#settings.selectRestoredThread(resumed);
                await this.#settings.probeCollaborationMode(this.#nativeSessionId, context.signal);
                await this.#emitAvailableCommands();
                return { configOptions: this.#settings.configOptions() };
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                if (isCompactPrompt(context.params.prompt)) {
                    return await this.#compact(context.signal);
                }
                const messageId = crypto.randomUUID();
                for (const content of context.params.prompt) {
                    await this.#emit({
                        content,
                        messageId,
                        sessionUpdate: "user_message_chunk",
                    });
                }
                return await this.#runTurn(promptInput(context.params.prompt), context.signal);
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => await this.#steerTurn(context.params, context.signal),
            )
            .onRequest(methods.agent.session.list, async (context) => {
                const decoded = threadListResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/list",
                        { cursor: context.params.cursor ?? null },
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
                await this.#interruptTurn();
            })
            .onNotification(methods.agent.session.cancel, async () => {
                await this.#interruptTurn();
            });
    }

    /** The ACP agent app Mobius connects its own ACP client to, in-process. */
    readonly app = (): AgentApp => this.#app;
    readonly nativeTurnId = (): string | null => this.#nativeTurnId;

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
                const child = this.#appServer.child();
                try {
                    const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
                    await stopProcessTree(child, captured);
                } finally {
                    this.#connection?.close();
                }
            })();
        }
        return this.#closePromise;
    };

    /**
     * Reads the model catalog once per app-server. A failure leaves the catalog empty, which costs
     * the Run settings panel its model selector; it must not cost the conversation itself, so the
     * turn lifecycle continues without settings rather than failing initialization.
     */
    readonly #replayHistory = async (
        turns: readonly { readonly items: readonly unknown[] }[] | null | undefined,
    ): Promise<void> => {
        for (const turn of turns ?? []) {
            for (const rawItem of turn.items) {
                const item = decodeThreadItem(rawItem);
                if (item === null) {
                    continue;
                }
                if (item.type === "userMessage") {
                    const text = item.content
                        .flatMap((content) => {
                            if (typeof content !== "object" || content === null) {
                                return [];
                            }
                            const type = Reflect.get(content, "type");
                            const text = Reflect.get(content, "text");
                            return type === "text" && typeof text === "string" ? [text] : [];
                        })
                        .join("");
                    if (text.length > 0) {
                        await this.#emit({
                            content: { text, type: "text" },
                            messageId: item.id,
                            sessionUpdate: "user_message_chunk",
                        });
                    }
                    continue;
                }
                if (item.type === "agentMessage") {
                    await this.#emit(agentMessageUpdate(item.id, item.text, item.phase));
                    continue;
                }
                const update = toolCallUpdate(item, "snapshot");
                if (update !== null) {
                    await this.#emit({ ...update, sessionUpdate: "tool_call_update" });
                }
            }
        }
    };

    readonly #emit = async (update: SessionNotification["update"]): Promise<void> => {
        const connection = this.#connection;
        if (connection === null || this.#nativeSessionId.length === 0) {
            return;
        }
        await connection.client.notify(methods.client.session.update, {
            sessionId: this.#nativeSessionId,
            update,
        });
    };

    readonly #emitAvailableCommands = async (): Promise<void> => {
        await this.#emit({
            availableCommands: CODEX_COMMANDS.map((command) => ({ ...command })),
            sessionUpdate: "available_commands_update",
        });
    };

    /** Pushes the current settings so a mode change Codex applied reaches the Run settings panel. */
    readonly #emitConfigOptionsUpdate = async (): Promise<void> => {
        const connection = this.#connection;
        if (connection === null || this.#nativeSessionId.length === 0) {
            return;
        }
        await connection.client.notify(methods.client.session.update, {
            sessionId: this.#nativeSessionId,
            update: { configOptions: this.#settings.configOptions(), sessionUpdate: "config_option_update" },
        });
    };

    // Notifications are serialized so two app-server items cannot interleave into one ACP update
    // stream, and the caller awaits the result: `turn/completed` must not resolve the prompt before
    // the updates it precedes have reached the client.
    readonly #enqueue = async (operation: () => Promise<void>): Promise<void> => {
        const pending = this.#updateTail.then(operation, operation);
        this.#updateTail = pending;
        await pending;
    };

    readonly #onNotification = async (method: string, params: unknown): Promise<void> => {
        if (method === "error") {
            const decoded = errorNotificationSchema.safeParse(params);
            if (
                decoded.success &&
                decoded.data.willRetry &&
                decoded.data.threadId === this.#nativeSessionId &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id
            ) {
                const id = `codex:${decoded.data.turnId}:error`;
                const revision = (this.#noticeRevisions.get(id) ?? 0) + 1;
                this.#noticeRevisions.set(id, revision);
                await this.#enqueue(async () => {
                    await this.#emit({
                        _meta: sessionFailureMeta({
                            category: "service",
                            id,
                            revision,
                            severity: "warning",
                            title: decoded.data.error.message,
                        }),
                        sessionUpdate: "session_info_update",
                    });
                });
            }
            return;
        }
        if (method === "turn/started") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#nativeSessionId && this.#turn !== null) {
                this.#turn.turn.id = decoded.data.turn.id;
                this.#nativeTurnId = decoded.data.turn.id;
            }
            return;
        }
        if (method === "turn/completed") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#nativeSessionId) {
                await this.#completeTurn(decoded.data.turn);
            }
            return;
        }
        if (method === "thread/name/updated") {
            const threadName = (params as { threadName?: unknown }).threadName;
            if (typeof threadName === "string" && threadName.length > 0) {
                await this.#enqueue(async () => {
                    await this.#emit({ sessionUpdate: "session_info_update", title: threadName });
                });
            }
            return;
        }
        if (method === "thread/settings/updated") {
            const decoded = threadSettingsUpdatedSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#nativeSessionId) {
                const mode = decoded.data.threadSettings.collaborationMode?.mode;
                if (this.#settings.observeCollaborationMode(mode)) {
                    await this.#enqueue(async () => {
                        await this.#emitConfigOptionsUpdate();
                    });
                }
            }
            return;
        }
        if (method === "turn/plan/updated") {
            const plan = (params as { plan?: unknown }).plan;
            if (Array.isArray(plan) && (params as { threadId?: unknown }).threadId === this.#nativeSessionId) {
                const entries = plan.map((step) => ({
                    content:
                        typeof step === "object" && step !== null && "step" in step
                            ? String(Reflect.get(step, "step"))
                            : "",
                    priority: "medium" as const,
                    status: "in_progress" as const,
                }));
                await this.#enqueue(async () => {
                    await this.#emit({ entries, sessionUpdate: "plan" });
                });
            }
            return;
        }
        if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (
                decoded.success &&
                decoded.data.threadId === this.#nativeSessionId &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                this.#streamedReasoningItemIds.add(decoded.data.itemId);
                await this.#enqueue(async () => {
                    await this.#emit({
                        content: { text: decoded.data.delta, type: "text" },
                        messageId: decoded.data.itemId,
                        sessionUpdate: "agent_thought_chunk",
                    });
                });
            }
            return;
        }
        if (method === "item/agentMessage/delta") {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (
                decoded.success &&
                decoded.data.threadId === this.#nativeSessionId &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                const phase = this.#agentMessages.get(decoded.data.itemId)?.phase;
                this.#agentMessages.set(decoded.data.itemId, { phase, kind: "streaming" });
                await this.#enqueue(async () => {
                    await this.#emit(agentMessageUpdate(decoded.data.itemId, decoded.data.delta, phase));
                });
            }
            return;
        }
        if (method !== "item/started" && method !== "item/completed") {
            return;
        }
        const item = decodeThreadItem((params as { item?: unknown }).item);
        if (item === null) {
            return;
        }
        if (item.type === "agentMessage") {
            // An item/completed agent message carries the whole text and would duplicate the deltas
            // already streamed for the same item.
            if (method === "item/started") {
                this.#agentMessages.set(item.id, { phase: item.phase, kind: "started" });
                return;
            }
            const message = this.#agentMessages.get(item.id);
            this.#agentMessages.delete(item.id);
            if (message?.kind === "streaming") {
                return;
            }
            await this.#enqueue(async () => {
                await this.#emit(agentMessageUpdate(item.id, item.text, item.phase));
            });
            return;
        }
        const reasoning = reasoningText(item);
        if (reasoning !== null) {
            const streamed = method === "item/completed" && this.#streamedReasoningItemIds.delete(item.id);
            if (method === "item/completed" && reasoning.length > 0 && !streamed) {
                await this.#enqueue(async () => {
                    await this.#emit({
                        content: { text: reasoning, type: "text" },
                        messageId: item.id,
                        sessionUpdate: "agent_thought_chunk",
                    });
                });
            }
            return;
        }
        const update = toolCallUpdate(item, method === "item/completed" ? "completed" : "started");
        if (update !== null) {
            await this.#enqueue(async () => {
                await this.#emit({ ...update, sessionUpdate: "tool_call_update" });
            });
        }
    };

    readonly #onServerRequest = async (request: CodexAppServerServerRequest): Promise<void> => {
        if (
            request.method === "item/commandExecution/requestApproval" ||
            request.method === "item/fileChange/requestApproval"
        ) {
            await this.#requestApproval(request);
            return;
        }
        if (request.method === "item/tool/requestUserInput") {
            await this.#requestUserInput(request);
            return;
        }
        if (request.method === "mcpServer/elicitation/request") {
            await this.#requestMcpElicitation(request);
            return;
        }
        // Mobius did not opt into these capabilities. Answering an error keeps the conversation
        // honest instead of letting the app-server wait on a request nobody will handle.
        this.#appServer.respondWithError(request.id, -32_601, `Mobius does not support ${request.method}`);
    };

    readonly #askPermission = async (
        title: string,
        toolCallId: string,
        signal: AbortSignal,
    ): Promise<"accept" | "acceptForSession" | "decline" | "cancel"> => {
        const connection = this.#connection;
        if (connection === null) {
            return "cancel";
        }
        const response = await connection.client.request(
            methods.client.session.requestPermission,
            {
                options: [...APPROVAL_OPTIONS],
                sessionId: this.#nativeSessionId,
                toolCall: { title, toolCallId },
            },
            { cancellationSignal: signal },
        );
        return response.outcome.outcome === "selected" ? permissionDecision(response.outcome.optionId) : "cancel";
    };

    readonly #requestApproval = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded =
            request.method === "item/commandExecution/requestApproval"
                ? commandApprovalParamsSchema.safeParse(request.params)
                : fileChangeApprovalParamsSchema.safeParse(request.params);
        if (!decoded.success) {
            this.#appServer.respondWithError(request.id, -32_602, "Mobius could not read the approval request");
            return;
        }
        const params = decoded.data;
        const command = "command" in params ? params.command : undefined;
        const title = (command ?? params.reason ?? "Approve a local change").slice(0, APPROVAL_REASON_CHARACTER_LIMIT);
        const turn = this.#turn;
        const decision = await this.#askPermission(
            title,
            params.itemId,
            AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS),
        );
        void turn;
        this.#appServer.respond(request.id, { decision });
    };

    readonly #requestUserInput = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded = requestUserInputParamsSchema.safeParse(request.params);
        const connection = this.#connection;
        if (!decoded.success || connection === null) {
            this.#appServer.respond(request.id, { answers: {} });
            return;
        }
        const questions = decoded.data.questions;
        const response = await connection.client.request(
            methods.client.elicitation.create,
            {
                message: questions
                    .map((question) => question.question)
                    .join("\n\n")
                    .slice(0, 2_000),
                mode: "form",
                requestedSchema: userInputSchema(questions),
                sessionId: this.#nativeSessionId,
                ...(decoded.data.itemId == null ? {} : { toolCallId: decoded.data.itemId }),
            },
            { cancellationSignal: AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS) },
        );
        const content = response.action === "accept" ? Reflect.get(response, "content") : undefined;
        const answers: Record<string, unknown> = {};
        for (const question of questions) {
            const value =
                typeof content === "object" && content !== null ? Reflect.get(content, question.id) : undefined;
            answers[question.id] = { answers: typeof value === "string" && value.length > 0 ? [value] : [] };
        }
        this.#appServer.respond(request.id, { answers });
    };

    readonly #requestMcpElicitation = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded = mcpElicitationParamsSchema.safeParse(request.params);
        const connection = this.#connection;
        if (!decoded.success || connection === null) {
            this.#appServer.respondWithError(request.id, -32_602, "Mobius could not read the elicitation request");
            return;
        }
        const params: McpElicitationParams = decoded.data;
        const signal = AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS);
        if (params.mode === "url" && params.url !== undefined) {
            const response = await connection.client.request(
                methods.client.elicitation.create,
                {
                    elicitationId: `${this.#nativeSessionId}-${String(request.id)}`,
                    message: params.message,
                    mode: "url",
                    sessionId: this.#nativeSessionId,
                    url: params.url,
                },
                { cancellationSignal: signal },
            );
            this.#appServer.respond(request.id, { action: response.action });
            return;
        }
        const response = await connection.client.request(
            methods.client.elicitation.create,
            {
                message: params.message,
                mode: "form",
                requestedSchema: params.requestedSchema ?? { properties: {}, required: [], type: "object" },
                sessionId: this.#nativeSessionId,
            },
            { cancellationSignal: signal },
        );
        const content = response.action === "accept" ? (Reflect.get(response, "content") ?? null) : null;
        this.#appServer.respond(request.id, { action: response.action, content });
    };

    readonly #runTurn = async (input: readonly unknown[], signal: AbortSignal): Promise<PromptResponse> => {
        signal.throwIfAborted();
        if (this.#turn !== null) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const completion = Promise.withResolvers<PromptResponse>();
        // A failure can arrive before turn/start responds. Its rejection is awaited below,
        // but must already be handled while that RPC is still pending.
        void completion.promise.catch(() => {});
        const aborted = (): void => {
            completion.reject(signal.reason);
            void this.close().catch((cause: unknown) => {
                console.error("The cancelled Codex endpoint could not release its process tree", cause);
            });
        };
        signal.addEventListener("abort", aborted, { once: true });
        // The turn is armed before `turn/start` is sent: a short turn can complete before its own
        // response arrives, and a completion for an unarmed turn would be lost.
        const turn: ActiveTurn = { completion, turn: { id: "" } };
        this.#agentMessages.clear();
        this.#streamedReasoningItemIds.clear();
        this.#turn = turn;
        this.#nativeTurnId = null;
        try {
            // The selection rides on the turn rather than the thread, so a choice made between turns
            // applies to the next one without restarting the conversation. Approval and sandboxing
            // travel as a pair: Codex resolves them together into the mode's single preset.
            const started = turnSchema.parse(
                (
                    (await this.#appServer.request(
                        "turn/start",
                        {
                            ...this.#settings.turnParameters(),
                            input,
                            threadId: this.#nativeSessionId,
                        },
                        signal,
                    )) as { turn?: unknown }
                ).turn,
            );
            if (this.#turn === turn) {
                turn.turn.id = started.id;
                this.#nativeTurnId = started.id;
            }
            return await completion.promise;
        } finally {
            signal.removeEventListener("abort", aborted);
            if (this.#turn === turn) {
                this.#turn = null;
                this.#agentMessages.clear();
                this.#streamedReasoningItemIds.clear();
            }
        }
    };

    readonly #compact = async (signal: AbortSignal): Promise<PromptResponse> => {
        signal.throwIfAborted();
        if (this.#turn !== null) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const completion = Promise.withResolvers<PromptResponse>();
        void completion.promise.catch(() => {});
        const aborted = (): void => {
            completion.reject(signal.reason);
            void this.close().catch((cause: unknown) => {
                console.error("The cancelled Codex endpoint could not release its process tree", cause);
            });
        };
        signal.addEventListener("abort", aborted, { once: true });
        const turn: ActiveTurn = { completion, turn: { id: "" } };
        this.#streamedReasoningItemIds.clear();
        this.#turn = turn;
        try {
            await this.#appServer.request("thread/compact/start", { threadId: this.#nativeSessionId }, signal);
            const result = await completion.promise;
            if (result.stopReason !== "cancelled") {
                await this.#emit({
                    content: { text: COMPACT_COMPLETED_MESSAGE, type: "text" },
                    messageId: turn.turn.id.length > 0 ? turn.turn.id : "compact-completed",
                    sessionUpdate: "agent_message_chunk",
                });
            }
            return result;
        } finally {
            signal.removeEventListener("abort", aborted);
            if (this.#turn === turn) {
                this.#turn = null;
                this.#streamedReasoningItemIds.clear();
            }
        }
    };

    readonly #steerTurn = async (
        params: unknown,
        signal: AbortSignal,
    ): Promise<{ readonly outcome: "injected" | "promptRequired"; readonly reason?: string }> => {
        if (typeof params !== "object" || params === null) {
            throw new AcpExecutionError("Codex received an invalid steering request", {}, "invalid_request");
        }
        const sessionId = Reflect.get(params, "sessionId");
        const prompt = Reflect.get(params, "prompt");
        if (typeof sessionId !== "string" || !Array.isArray(prompt)) {
            throw new AcpExecutionError("Codex received an invalid steering request", {}, "invalid_request");
        }
        const active = this.#turn;
        if (sessionId !== this.#nativeSessionId || active === null || active.turn.id.length === 0) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const steering = steeringPrompt(prompt);
        if (steering.length === 0) {
            throw new AcpExecutionError("Codex received an empty steering request", {}, "invalid_request");
        }
        const messageId = crypto.randomUUID();
        for (const block of steering) {
            await this.#emit({ content: block.content, messageId, sessionUpdate: "user_message_chunk" });
        }
        const response = turnSteerResponseSchema.parse(
            await this.#appServer.request(
                "turn/steer",
                {
                    expectedTurnId: active.turn.id,
                    input: steering.map((block) => block.input),
                    threadId: this.#nativeSessionId,
                },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            ),
        );
        if (response.turnId !== active.turn.id) {
            throw new AcpExecutionError("Codex steered an unexpected turn", {}, "steering_target_unavailable");
        }
        return { outcome: "injected" };
    };

    readonly #interruptTurn = async (): Promise<void> => {
        const turn = this.#turn;
        if (turn === null) {
            return;
        }
        this.#turn = null;
        if (turn.turn.id.length > 0) {
            try {
                await this.#appServer.request(
                    "turn/interrupt",
                    { threadId: this.#nativeSessionId, turnId: turn.turn.id },
                    AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS),
                );
            } catch {
                // Turn completion below remains authoritative.
            }
        }
        turn.completion.resolve({ stopReason: "cancelled" });
    };

    readonly #completeTurn = async (turn: {
        readonly error?: { readonly message: string } | null | undefined;
        readonly status: string;
    }): Promise<void> => {
        const active = this.#turn;
        if (active === null) {
            return;
        }
        // Keep this Turn reachable by termination and cancellation until its output has drained.
        // The app-server dispatches notifications concurrently, so an item update can still be in
        // flight when the turn completes. Drain it: a client must never see the turn finish before
        // the activity that belongs to it.
        await this.#updateTail;
        if (turn.status === "failed") {
            active.completion.reject(
                new AcpExecutionError(turn.error?.message ?? "The Codex turn failed", {}, "codex_turn_failed"),
            );
            return;
        }
        active.completion.resolve({ stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn" });
    };
}
