import {
    type AgentApp,
    type AgentConnection,
    type ContentBlock,
    agent as createAgentApp,
    methods,
    type PermissionOption,
    PROTOCOL_VERSION,
    type PromptResponse,
    type SessionConfigOption,
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
import { CodexAppServerClient, type CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    type CodexModel,
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
    modelListResponseSchema,
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
import { agentMessageMeta, decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";

const APPROVAL_REASON_CHARACTER_LIMIT = 500;
const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
const CODEX_AGENT_VERSION = "0.154.0";
// Listing a directory must answer promptly: it is an interactive browser request, not a turn.
const SESSION_LIST_TIMEOUT_MILLISECONDS = 30_000;
// The setting identifiers Mobius matches on. These are the ids the retired
// `@agentclientprotocol/codex-acp` adapter advertised, so conversations that stored a selection
// under them keep applying after the move in-process.
const MODEL_SETTING_ID = "model";
const REASONING_EFFORT_SETTING_ID = "reasoning_effort";
const MODE_SETTING_ID = "mode";
const FAST_MODE_SETTING_ID = "fast-mode";
const COLLABORATION_MODE_SETTING_ID = "collaboration_mode";
const MODEL_CATALOG_LIMIT = 1_000;
// `additionalSpeedTiers` and `serviceTier` are two vocabularies for one concept: a model advertises
// "fast" while the thread reports the resolved tier as "priority". Fast mode is offered per model,
// because most models have no speed tier at all.
const FAST_TIER = "fast";
const SERVICE_TIER_FAST = "priority";
const CODEX_COMMANDS = Object.freeze([{ description: "Compact the conversation context", name: "compact" }]);

interface AgentMode {
    readonly approvalsReviewer: string;
    readonly approvalPolicy: string;
    readonly description: string;
    readonly id: string;
    readonly name: string;
    readonly sandboxPolicy: Readonly<Record<string, unknown>>;
}

const WORKSPACE_WRITE_POLICY: Readonly<Record<string, unknown>> = Object.freeze({
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [],
});

/**
 * The approval and sandboxing presets Mobius offers, matching the adapter this Agent replaced so an
 * existing conversation's stored selection keeps its meaning. Each preset carries the full policy
 * pair, because Codex takes approval and sandboxing together.
 */
const READ_ONLY_MODE: AgentMode = Object.freeze({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    description: "Always ask to edit external files and use the internet",
    id: "read-only",
    name: "Ask for approval",
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
});
const AGENT_MODE: AgentMode = Object.freeze({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    description: "Only ask for actions detected as potentially unsafe",
    id: "agent",
    name: "Approve for me",
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
});
const FULL_ACCESS_MODE: AgentMode = Object.freeze({
    approvalPolicy: "never",
    approvalsReviewer: "user",
    description: "Unrestricted access to the internet and any file on your computer",
    id: "agent-full-access",
    name: "Full access",
    sandboxPolicy: { type: "dangerFullAccess" },
});

const AGENT_MODES: readonly AgentMode[] = Object.freeze([READ_ONLY_MODE, AGENT_MODE, FULL_ACCESS_MODE]);
const DEFAULT_MODE = AGENT_MODE;

/**
 * The mode the session opens in, from the same `INITIAL_AGENT_MODE` variable the adapter this Agent
 * replaced honoured. The default is only a fallback: a host that configured the variable keeps the
 * behavior it had.
 */
function initialMode(environment: Readonly<Record<string, string>>): string {
    const requested = environment["INITIAL_AGENT_MODE"];
    if (requested === undefined) {
        return DEFAULT_MODE.id;
    }
    return AGENT_MODES.some((mode) => mode.id === requested) ? requested : DEFAULT_MODE.id;
}

function capitalize(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

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

function steeringPromptInput(prompt: readonly unknown[]): readonly unknown[] {
    const input: unknown[] = [];
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
            input.push({ text, text_elements: [], type: "text" });
            continue;
        }
        if (type === "image") {
            const data = Reflect.get(block, "data");
            const mimeType = Reflect.get(block, "mimeType");
            if (typeof data !== "string" || typeof mimeType !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            input.push({ type: "image", url: `data:${mimeType};base64,${data}` });
            continue;
        }
        if (type === "resource") {
            const resource = Reflect.get(block, "resource");
            if (typeof resource !== "object" || resource === null) {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            const text = Reflect.get(resource, "text");
            if (text !== undefined && typeof text !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            input.push({ text: text ?? "", text_elements: [], type: "text" });
            continue;
        }
        if (type === "resource_link") {
            const uri = Reflect.get(block, "uri");
            if (typeof uri !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            input.push({ text: `Resource: ${uri}`, text_elements: [], type: "text" });
            continue;
        }
        throw new AcpExecutionError("Codex received an unsupported steering prompt", {}, "invalid_request");
    }
    return input;
}

interface ActiveTurn {
    readonly completion: PromiseWithResolvers<PromptResponse>;
    readonly turn: { id: string };
}

/**
 * The model and reasoning effort this session runs with. Codex reports the pair it resolved from its
 * own configuration on `thread/start`; a `session/set_config_option` replaces either half. Both are
 * sent on `turn/start`, which is how Codex applies them to the turn being started.
 */
interface SessionSelection {
    collaborationMode: string;
    effort: string;
    fastMode: boolean;
    mode: string;
    model: string;
}

interface ConfigValue {
    readonly description: string;
    readonly name: string;
    readonly value: string;
}

function modelValues(models: readonly CodexModel[]): ConfigValue[] {
    return models.map((model) => ({
        description: model.description ?? "",
        name: model.displayName ?? model.id,
        value: model.id,
    }));
}

function effortValues(model: CodexModel | undefined): ConfigValue[] {
    return (model?.supportedReasoningEfforts ?? []).map((option) => ({
        description: option.description ?? "",
        name: capitalize(option.reasoningEffort),
        value: option.reasoningEffort,
    }));
}

function supportedSelection(models: readonly CodexModel[], reportedModel: string, reportedEffort: string) {
    const model =
        models.find((candidate) => candidate.id === reportedModel) ??
        models.find((candidate) => candidate.isDefault === true) ??
        models[0];
    if (model === undefined) {
        return { model: reportedModel, effort: reportedEffort };
    }
    const efforts = model.supportedReasoningEfforts ?? [];
    return {
        model: model.id,
        effort: efforts.some((candidate) => candidate.reasoningEffort === reportedEffort)
            ? reportedEffort
            : (model.defaultReasoningEffort ?? efforts[0]?.reasoningEffort ?? ""),
    };
}

function modelSetting(models: readonly CodexModel[], currentValue: string): SessionConfigOption | null {
    const values = modelValues(models);
    // A model left in config.toml may be absent from the account's catalog. Offer a catalog model
    // as the selection so a new Session can start with a model Codex actually supports.
    const current = values.some((value) => value.value === currentValue)
        ? currentValue
        : (models.find((model) => model.isDefault === true)?.id ?? values[0]?.value ?? "");
    if (current.length === 0) {
        return null;
    }
    return {
        category: "model",
        currentValue: current,
        description: "Model Codex uses for the session",
        id: MODEL_SETTING_ID,
        name: "Model",
        options: values,
        type: "select",
    };
}

function modeSetting(currentValue: string): SessionConfigOption {
    return {
        category: "mode",
        currentValue,
        description: "Approval and sandboxing preset for the session",
        id: MODE_SETTING_ID,
        name: "Mode",
        options: AGENT_MODES.map((mode) => ({
            description: mode.description,
            name: mode.name,
            value: mode.id,
        })),
        type: "select",
    };
}

/**
 * How Codex collaborates on subsequent turns. "Build" is Codex's `default` mode; "Plan" makes Codex
 * research and propose a plan before making changes. The ids match the retired
 * `@agentclientprotocol/codex-acp` adapter so a saved selection keeps applying.
 */
const COLLABORATION_MODES: readonly ConfigValue[] = Object.freeze([
    { description: "Codex answers and makes changes directly", name: "Build", value: "default" },
    { description: "Codex plans before making changes", name: "Plan", value: "plan" },
]);

function collaborationModeSetting(currentValue: string): SessionConfigOption {
    const current = COLLABORATION_MODES.some((mode) => mode.value === currentValue)
        ? currentValue
        : (COLLABORATION_MODES[0]?.value ?? "default");
    return {
        category: "collaboration_mode",
        currentValue: current,
        description: "How Codex collaborates for subsequent turns",
        id: COLLABORATION_MODE_SETTING_ID,
        name: "Collaboration mode",
        options: [...COLLABORATION_MODES],
        type: "select",
    };
}

/**
 * Fast mode is a toggle, and it is only offered for a model that has a speed tier. A model without
 * one is not a disabled toggle: switching to it removes the setting, which is how the adapter this
 * Agent replaced behaved and why the option disappears rather than greys out.
 */
function fastModeSetting(model: CodexModel | undefined, enabled: boolean): SessionConfigOption | null {
    if (model?.additionalSpeedTiers?.includes(FAST_TIER) !== true) {
        return null;
    }
    return {
        category: "model_config",
        currentValue: enabled,
        description: "1.5x speed, increased usage",
        id: FAST_MODE_SETTING_ID,
        name: "Fast mode",
        type: "boolean",
    };
}

function effortSetting(model: CodexModel | undefined, currentValue: string): SessionConfigOption | null {
    const values = effortValues(model);
    if (values.length === 0) {
        return null;
    }
    const current = values.some((value) => value.value === currentValue) ? currentValue : (values[0]?.value ?? "");
    if (current.length === 0) {
        return null;
    }
    return {
        category: "thought_level",
        currentValue: current,
        description: "How much reasoning effort the model should use",
        id: REASONING_EFFORT_SETTING_ID,
        name: "Reasoning effort",
        options: values,
        type: "select",
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
    #models: readonly CodexModel[] = [];
    #nativeSessionId = "";
    // Whether the current turn must carry a policy at all. Until the user picks a mode, Codex's own
    // configuration decides, so `turn/start` omits the fields and inherits what the host set up.
    #policySelected = false;
    // Whether a collaboration mode choice has been made in this session. A restored thread keeps
    // the mode Codex already persisted, so the first turn does not reset it to Build.
    #collaborationModeSelected = false;
    // Whether the app-server accepts collaboration mode on `turn/start`, probed once per
    // app-server. An older Codex rejects the experimental field, and the setting must disappear
    // rather than break every turn.
    #collaborationModeSupported: boolean | null = null;
    #selection: SessionSelection;
    readonly #streamedReasoningItemIds = new Set<string>();
    #turn: ActiveTurn | null = null;
    #nativeTurnId: string | null = null;
    #updateTail: Promise<void> = Promise.resolve();

    constructor(options: InProcessAcpEndpointOptions) {
        this.#selection = {
            collaborationMode: "default",
            effort: "",
            fastMode: false,
            mode: initialMode(options.environment),
            model: "",
        };
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
                // A new thread always starts in the default mode, so only the model and effort come
                // from Codex. The mode is re-applied on the first turn.
                const supported = supportedSelection(this.#models, created.model ?? "", created.reasoningEffort ?? "");
                this.#selection = {
                    ...this.#selection,
                    collaborationMode: "default",
                    ...supported,
                };
                this.#collaborationModeSelected = false;
                await this.#probeCollaborationMode(context.signal);
                await this.#emitAvailableCommands();
                // The settings Mobius discovers come from this response. Without them the Run
                // settings panel has nothing to render and saved selections cannot be re-applied.
                return { configOptions: this.#configOptions(), sessionId: created.thread.id };
            })
            .onRequest(methods.agent.session.setConfigOption, async (context) => {
                this.#applySelection(context.params.configId, context.params.value);
                return { configOptions: this.#configOptions() };
            })
            // Mobius routes a `category: "mode"` selection here rather than through
            // set_config_option, so the mode needs its own entry point.
            .onRequest(methods.agent.session.setMode, async (context) => {
                this.#applySelection(MODE_SETTING_ID, context.params.modeId);
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
                this.#selectRestoredThread(resumed);
                await this.#probeCollaborationMode(context.signal);
                await this.#replayHistory(resumed.turns);
                await this.#emitAvailableCommands();
                return { configOptions: this.#configOptions() };
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
                this.#selectRestoredThread(forked);
                await this.#probeCollaborationMode(context.signal);
                await this.#replayHistory(forked.turns);
                await this.#emitAvailableCommands();
                return { configOptions: this.#configOptions(), sessionId: forked.thread.id };
            })
            .onRequest(methods.agent.session.resume, async (context) => {
                const resumed = threadResumeResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/resume",
                        { cwd: context.params.cwd, excludeTurns: true, threadId: context.params.sessionId },
                        AbortSignal.any([context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                this.#selectRestoredThread(resumed);
                await this.#probeCollaborationMode(context.signal);
                await this.#emitAvailableCommands();
                return { configOptions: this.#configOptions() };
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                if (isCompactPrompt(context.params.prompt)) {
                    return await this.#compact(context.signal);
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
        await this.#loadModels(signal);
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
    readonly #loadModels = async (signal: AbortSignal): Promise<void> => {
        const models: CodexModel[] = [];
        let cursor: string | null = null;
        try {
            do {
                const decoded = modelListResponseSchema.parse(
                    await this.#appServer.request(
                        "model/list",
                        { cursor, limit: null },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                models.push(...decoded.data);
                cursor = decoded.nextCursor ?? null;
            } while (cursor !== null && models.length < MODEL_CATALOG_LIMIT);
        } catch (error) {
            signal.throwIfAborted();
            process.stderr.write(`[codex-acp] model catalog unavailable: ${String(error)}\n`);
        }
        this.#models = Object.freeze(models.slice(0, MODEL_CATALOG_LIMIT));
    };

    readonly #model = (id: string): CodexModel | undefined => this.#models.find((model) => model.id === id);

    /**
     * Learns, once per app-server, whether collaboration mode can be applied. An empty settings
     * update is a no-op on a supporting Codex; an older Codex answers an error, which costs the
     * Build/Plan selector alone without changing a restored thread's persisted mode.
     */
    readonly #probeCollaborationMode = async (signal: AbortSignal): Promise<void> => {
        if (this.#collaborationModeSupported !== null) {
            return;
        }
        try {
            await this.#appServer.request(
                "thread/settings/update",
                { threadId: this.#nativeSessionId },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            );
            this.#collaborationModeSupported = true;
        } catch {
            signal.throwIfAborted();
            this.#collaborationModeSupported = false;
        }
    };

    /** The ACP settings Mobius discovers and renders in Run settings. */
    readonly #configOptions = (): SessionConfigOption[] => {
        const options: SessionConfigOption[] = [];
        const model = modelSetting(this.#models, this.#selection.model);
        if (model !== null) {
            options.push(model);
        }
        const effort = effortSetting(this.#model(this.#selection.model), this.#selection.effort);
        if (effort !== null) {
            options.push(effort);
        }
        const fastMode = fastModeSetting(this.#model(this.#selection.model), this.#selection.fastMode);
        if (fastMode !== null) {
            options.push(fastMode);
        }
        if (this.#collaborationModeSupported === true) {
            options.push(collaborationModeSetting(this.#selection.collaborationMode));
        }
        options.push(modeSetting(this.#selection.mode));
        return options;
    };

    readonly #selectRestoredThread = (thread: {
        readonly model?: string | null | undefined;
        readonly reasoningEffort?: string | null | undefined;
        readonly serviceTier?: string | null | undefined;
        readonly thread: { readonly id: string };
    }): void => {
        this.#nativeSessionId = thread.thread.id;
        const supported = supportedSelection(
            this.#models,
            thread.model ?? this.#selection.model,
            thread.reasoningEffort ?? this.#selection.effort,
        );
        this.#selection = {
            ...this.#selection,
            ...supported,
            fastMode: thread.serviceTier === SERVICE_TIER_FAST,
        };
    };

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
                    await this.#emit({
                        _meta: agentMessageMeta(item.phase),
                        content: { text: item.text, type: "text" },
                        messageId: item.id,
                        sessionUpdate: "agent_message_chunk",
                    });
                    continue;
                }
                const update = toolCallUpdate(item, "snapshot");
                if (update !== null) {
                    await this.#emit({ ...update, sessionUpdate: "tool_call_update" });
                }
            }
        }
    };

    /**
     * Applies one `session/set_config_option`. Switching models re-resolves the effort the way Codex
     * does — the current effort when the new model supports it, otherwise the model's own default —
     * so the reply never advertises an effort the selected model cannot run.
     */
    readonly #applySelection = (configId: string, value: string | boolean): void => {
        if (configId === FAST_MODE_SETTING_ID) {
            if (typeof value !== "boolean") {
                throw new AcpExecutionError(
                    "The requested Codex setting is invalid",
                    {},
                    "invalid_session_configuration",
                );
            }
            // A model without a speed tier has no fast mode, so enabling it there would advertise a
            // capability the next turn cannot honour.
            if (value && this.#model(this.#selection.model)?.additionalSpeedTiers?.includes(FAST_TIER) !== true) {
                throw new AcpExecutionError(
                    "The selected Codex model has no fast mode",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, fastMode: value };
            return;
        }
        if (typeof value !== "string") {
            throw new AcpExecutionError("The requested Codex setting is invalid", {}, "invalid_session_configuration");
        }
        if (configId === MODE_SETTING_ID) {
            if (!AGENT_MODES.some((mode) => mode.id === value)) {
                throw new AcpExecutionError(
                    "The requested Codex mode is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, mode: value };
            this.#policySelected = true;
            return;
        }
        if (configId === COLLABORATION_MODE_SETTING_ID) {
            if (!COLLABORATION_MODES.some((mode) => mode.value === value)) {
                throw new AcpExecutionError(
                    "The requested Codex collaboration mode is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, collaborationMode: value };
            this.#collaborationModeSelected = true;
            return;
        }
        if (configId === MODEL_SETTING_ID) {
            if (value === this.#selection.model) {
                return;
            }
            const model = this.#model(value);
            if (model === undefined) {
                throw new AcpExecutionError(
                    "The requested Codex model is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            const supported = (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort);
            const effort = supported.includes(this.#selection.effort)
                ? this.#selection.effort
                : (model.defaultReasoningEffort ?? supported[0] ?? "");
            // Fast mode follows the model: a model with no speed tier drops a fast mode that was on.
            this.#selection = {
                ...this.#selection,
                effort,
                fastMode: this.#selection.fastMode && model.additionalSpeedTiers?.includes(FAST_TIER) === true,
                model: value,
            };
            return;
        }
        if (configId === REASONING_EFFORT_SETTING_ID) {
            const supported = (this.#model(this.#selection.model)?.supportedReasoningEfforts ?? []).map(
                (option) => option.reasoningEffort,
            );
            if (!supported.includes(value)) {
                throw new AcpExecutionError(
                    "The requested Codex reasoning effort is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, effort: value };
            return;
        }
        throw new AcpExecutionError("The requested Codex setting is unavailable", {}, "invalid_session_configuration");
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
            update: { configOptions: this.#configOptions(), sessionUpdate: "config_option_update" },
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
                if (mode !== undefined && mode !== this.#selection.collaborationMode) {
                    this.#selection = { ...this.#selection, collaborationMode: mode };
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
                return;
            }
            await this.#enqueue(async () => {
                await this.#emit({
                    _meta: agentMessageMeta(item.phase),
                    content: { text: item.text, type: "text" },
                    messageId: item.id,
                    sessionUpdate: "agent_message_chunk",
                });
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
        this.#streamedReasoningItemIds.clear();
        this.#turn = turn;
        this.#nativeTurnId = null;
        try {
            // The selection rides on the turn rather than the thread, so a choice made between turns
            // applies to the next one without restarting the conversation. Approval and sandboxing
            // travel as a pair: Codex resolves them together into the mode's single preset.
            const selection = this.#selection;
            const mode = AGENT_MODES.find((candidate) => candidate.id === selection.mode) ?? DEFAULT_MODE;
            const supportsFast = this.#model(selection.model)?.additionalSpeedTiers?.includes(FAST_TIER) === true;
            const started = turnSchema.parse(
                (
                    (await this.#appServer.request(
                        "turn/start",
                        {
                            // Until a mode is chosen, `config.toml` decides the sandbox and approval
                            // policy, and those fields stay off the turn so the host's own setup is
                            // inherited rather than overridden.
                            ...(this.#policySelected
                                ? {
                                      approvalPolicy: mode.approvalPolicy,
                                      approvalsReviewer: mode.approvalsReviewer,
                                      sandboxPolicy: mode.sandboxPolicy,
                                  }
                                : {}),
                            // The collaboration mode rides on the turn: Codex applies it to the
                            // thread, where it persists until changed. "Build" is Codex's `default`
                            // mode, so it is only sent once a choice exists to apply.
                            ...(this.#collaborationModeSupported &&
                            (selection.collaborationMode !== "default" || this.#collaborationModeSelected)
                                ? {
                                      collaborationMode: {
                                          mode: selection.collaborationMode,
                                          settings: {
                                              developer_instructions: null,
                                              model: selection.model,
                                              reasoning_effort: selection.effort.length === 0 ? null : selection.effort,
                                          },
                                      },
                                  }
                                : {}),
                            ...(selection.effort.length === 0 ? {} : { effort: selection.effort }),
                            input,
                            ...(selection.model.length === 0 ? {} : { model: selection.model }),
                            ...(selection.fastMode && supportsFast ? { serviceTier: SERVICE_TIER_FAST } : {}),
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
            return await completion.promise;
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
        const input = steeringPromptInput(prompt);
        if (input.length === 0) {
            throw new AcpExecutionError("Codex received an empty steering request", {}, "invalid_request");
        }
        const response = turnSteerResponseSchema.parse(
            await this.#appServer.request(
                "turn/steer",
                { expectedTurnId: active.turn.id, input, threadId: this.#nativeSessionId },
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
