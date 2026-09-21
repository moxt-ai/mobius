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
import type { InProcessAcpEndpoint, InProcessAcpEndpointOptions } from "../in-process/acp-endpoint.ts";
import { CodexAppServerClient, type CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    type CodexModel,
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
    modelListResponseSchema,
    requestUserInputParamsSchema,
    threadStartResponseSchema,
    turnNotificationSchema,
    turnSchema,
    type UserInputQuestion,
} from "./app-server-protocol.ts";
import { agentMessageMeta, decodeThreadItem, toolCallUpdate } from "./items.ts";

const APPROVAL_REASON_CHARACTER_LIMIT = 500;
const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
const CODEX_AGENT_VERSION = "0.154.0";
// The setting identifiers Mobius matches on. These are the ids the retired
// `@agentclientprotocol/codex-acp` adapter advertised, so conversations that stored a selection
// under them keep applying after the move in-process.
const MODEL_SETTING_ID = "model";
const REASONING_EFFORT_SETTING_ID = "reasoning_effort";
const MODE_SETTING_ID = "mode";
const FAST_MODE_SETTING_ID = "fast-mode";
const MODEL_CATALOG_LIMIT = 1_000;
// `additionalSpeedTiers` and `serviceTier` are two vocabularies for one concept: a model advertises
// "fast" while the thread reports the resolved tier as "priority". Fast mode is offered per model,
// because most models have no speed tier at all.
const FAST_TIER = "fast";
const SERVICE_TIER_FAST = "priority";

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

function modelSetting(models: readonly CodexModel[], currentValue: string): SessionConfigOption | null {
    const values = modelValues(models);
    // The daemon drops any option whose current value is not one it offers, so a mismatch costs the
    // user the whole selector rather than one entry. Codex may name a model its catalog omits, and
    // may name none at all, so the offered list absorbs both cases.
    const current =
        currentValue.length > 0
            ? currentValue
            : (models.find((model) => model.isDefault === true)?.id ?? values[0]?.value ?? "");
    if (current.length === 0) {
        return null;
    }
    const options = values.some((value) => value.value === current)
        ? values
        : [{ description: "", name: current, value: current }, ...values];
    return {
        category: "model",
        currentValue: current,
        description: "Model Codex uses for the session",
        id: MODEL_SETTING_ID,
        name: "Model",
        options,
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
    #connection: AgentConnection | null = null;
    #models: readonly CodexModel[] = [];
    #nativeSessionId = "";
    // Whether the current turn must carry a policy at all. Until the user picks a mode, Codex's own
    // configuration decides, so `turn/start` omits the fields and inherits what the host set up.
    #policySelected = false;
    #selection: SessionSelection;
    #turn: ActiveTurn | null = null;
    #updateTail: Promise<void> = Promise.resolve();

    constructor(options: InProcessAcpEndpointOptions) {
        this.#selection = {
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
        this.#app = createAgentApp({ name: "mobius-codex" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            // Declare only what this Agent actually serves. Mobius gates every request on these bits,
            // so an optimistic bit here becomes an unsupported ACP call at the far end. Session
            // restore, listing, forking, and steering stay undeclared until they are implemented;
            // the daemon's existing degradation paths handle their absence.
            .onRequest(methods.agent.initialize, async () => ({
                agentCapabilities: {
                    loadSession: false,
                    promptCapabilities: { embeddedContext: true, image: true },
                    sessionCapabilities: { close: {} },
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
                this.#selection = {
                    ...this.#selection,
                    effort: created.reasoningEffort ?? "",
                    model: created.model ?? "",
                };
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
            .onRequest(methods.agent.session.prompt, async (context) => {
                return await this.#runTurn(promptInput(context.params.prompt), context.signal);
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

    /** Starts the app-server, performs its handshake, and reads the model catalog Codex offers. */
    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.#appServer.initialize(signal);
        await this.#loadModels(signal);
    };

    /**
     * Releases the app-server and every process it started. Mirrors the adapter path's teardown so a
     * cancelled or closed session cannot leak the tool subprocesses running under the app-server.
     */
    readonly close = async (): Promise<void> => {
        const child = this.#appServer.child();
        const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
        this.#appServer.detach();
        await stopProcessTree(child, captured);
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
        options.push(modeSetting(this.#selection.mode));
        return options;
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
                this.#turn = { completion: this.#turn.completion, turn: { id: decoded.data.turn.id } };
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
        const update = toolCallUpdate(item);
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
        if (this.#turn !== null) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const completion = Promise.withResolvers<PromptResponse>();
        // The turn is armed before `turn/start` is sent: a short turn can complete before its own
        // response arrives, and a completion for an unarmed turn would be lost.
        const turn: ActiveTurn = { completion, turn: { id: "" } };
        this.#turn = turn;
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
            }
            return await completion.promise;
        } finally {
            if (this.#turn === turn) {
                this.#turn = null;
            }
        }
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
        this.#turn = null;
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
