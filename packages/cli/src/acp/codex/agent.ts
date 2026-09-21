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
import type { InProcessAcpEndpoint, InProcessAcpEndpointOptions } from "../in-process/acp-endpoint.ts";
import { CodexAppServerClient, type CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
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
    #nativeSessionId = "";
    #turn: ActiveTurn | null = null;
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
                return { sessionId: created.thread.id };
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

    /** Starts the app-server and performs its handshake. */
    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.#appServer.initialize(signal);
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
            const started = turnSchema.parse(
                (
                    (await this.#appServer.request(
                        "turn/start",
                        { input, threadId: this.#nativeSessionId },
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
