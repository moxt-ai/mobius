import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
    AgentConnection,
    ContentBlock,
    PermissionOption,
    PromptResponse,
    SessionNotification,
} from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "../../acp-error.ts";
import { type AcpEndpointTermination, acpEndpointTerminationError } from "../../in-process/acp-endpoint.ts";
import type { CodexAppServerClient, CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
    reasoningTextDeltaParamsSchema,
    requestUserInputParamsSchema,
    threadSettingsUpdatedSchema,
    turnNotificationSchema,
    turnSchema,
    turnSteerResponseSchema,
    type UserInputQuestion,
} from "./app-server-protocol.ts";
import { decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";
import type { CodexSessionAgent } from "./session-agent.ts";
import type { CodexSettings } from "./settings.ts";

const APPROVAL_REASON_CHARACTER_LIMIT = 500;
const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
// Compaction summarizes the thread with one model call; generous but finite.
const COMPACT_TIMEOUT_MILLISECONDS = 3_600_000;
// How long a manual /compact keeps its turn open for the contextCompaction item
// before ending the turn without a compaction report (older servers).
const COMPACT_ITEM_WAIT_MILLISECONDS = 600_000;

interface OwnedAgentContext {
    readonly client: CodexAppServerClient;
    readonly settings: CodexSettings;
    readonly threadId: () => string;
    readonly connection: () => AgentConnection | null;
    readonly emit: (update: SessionNotification["update"]) => Promise<void>;
    readonly close: () => Promise<void>;
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

export function agentMessageUpdate(
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

/** Owns direct turns, their live notifications, and local approval requests. */
export class CodexOwnedAcpAgent implements CodexSessionAgent {
    readonly #context: OwnedAgentContext;
    readonly #appServer: CodexAppServerClient;
    readonly #settings: CodexSettings;
    readonly #streamedReasoningItemIds = new Set<string>();
    readonly #agentMessages = new Map<
        string,
        { readonly phase: "commentary" | "final_answer" | null | undefined; readonly kind: "started" | "streaming" }
    >();
    #turn: ActiveTurn | null = null;
    #nativeTurnId: string | null = null;
    #updateTail: Promise<void> = Promise.resolve();
    // Resolved by the contextCompaction item and thread/compacted handlers while a
    // manual /compact keeps its turn open until the compaction is reported.
    #onCompactionItemSettled: (() => void) | null = null;

    constructor(context: OwnedAgentContext) {
        this.#context = context;
        this.#appServer = context.client;
        this.#settings = context.settings;
    }

    readonly nativeTurnId = (): string | null => this.#nativeTurnId;
    readonly onTerminated = (termination: AcpEndpointTermination): void => {
        this.#turn?.completion.reject(acpEndpointTerminationError(termination));
    };
    readonly close = async (): Promise<void> => {
        this.#turn?.completion.reject(new AcpExecutionError("The Codex endpoint is closed", {}, "acp_endpoint_closed"));
    };

    /** Manual /compact: drives thread/compact/start directly (no turn is created).
     *  The app-server then reports the compaction as a contextCompaction item whose
     *  started/completed pair is the lifecycle clients see, so the turn stays open
     *  until that pair settles (bounded and cancellable). Only the RPC's failure is
     *  mapped here; success is never synthesized, so the compaction is reported
     *  exactly once. */
    readonly compact = async (signal: AbortSignal): Promise<PromptResponse> => {
        const reported = Promise.withResolvers<void>();
        this.#onCompactionItemSettled = () => reported.resolve();
        try {
            await this.#appServer.request(
                "thread/compact/start",
                { threadId: this.#context.threadId() },
                AbortSignal.any([signal, AbortSignal.timeout(COMPACT_TIMEOUT_MILLISECONDS)]),
            );
            await Promise.race([reported.promise, delay(COMPACT_ITEM_WAIT_MILLISECONDS, undefined, { signal })]);
        } catch (cause: unknown) {
            signal.throwIfAborted();
            const details = cause instanceof Error ? cause.message : String(cause);
            const compactionId = randomUUID();
            await this.#enqueue(async () => {
                await this.#context.emit({
                    compactionId,
                    error: details,
                    sessionUpdate: "compaction_update",
                    status: "failed",
                });
            });
            throw cause;
        } finally {
            this.#onCompactionItemSettled = null;
        }
        return { stopReason: "end_turn" };
    };

    /** Pushes the current settings so a mode change Codex applied reaches the Run settings panel. */
    readonly #emitConfigOptionsUpdate = async (): Promise<void> => {
        const connection = this.#context.connection();
        if (connection === null || this.#context.threadId().length === 0) {
            return;
        }
        await connection.client.notify(methods.client.session.update, {
            sessionId: this.#context.threadId(),
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

    readonly onNotification = async (method: string, params: unknown): Promise<void> => {
        if (method === "turn/started") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#context.threadId() && this.#turn !== null) {
                this.#turn.turn.id = decoded.data.turn.id;
                this.#nativeTurnId = decoded.data.turn.id;
            }
            return;
        }
        if (method === "turn/completed") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#context.threadId()) {
                await this.#completeTurn(decoded.data.turn);
            }
            return;
        }
        if (method === "thread/name/updated") {
            const threadName = (params as { threadName?: unknown }).threadName;
            if (typeof threadName === "string" && threadName.length > 0) {
                await this.#enqueue(async () => {
                    await this.#context.emit({ sessionUpdate: "session_info_update", title: threadName });
                });
            }
            return;
        }
        if (method === "thread/compacted") {
            // Older app-servers report compaction through this notification instead
            // of a contextCompaction item. It carries no summary, so a lone
            // completed update (fresh id) is the faithful mapping.
            await this.#enqueue(async () => {
                await this.#context.emit({
                    compactionId: randomUUID(),
                    sessionUpdate: "compaction_update",
                    status: "completed",
                });
                this.#onCompactionItemSettled?.();
            });
            return;
        }
        if (method === "thread/settings/updated") {
            const decoded = threadSettingsUpdatedSchema.safeParse(params);
            if (decoded.success && decoded.data.threadId === this.#context.threadId()) {
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
            if (Array.isArray(plan) && (params as { threadId?: unknown }).threadId === this.#context.threadId()) {
                const entries = plan.map((step) => ({
                    content:
                        typeof step === "object" && step !== null && "step" in step
                            ? String(Reflect.get(step, "step"))
                            : "",
                    priority: "medium" as const,
                    status: "in_progress" as const,
                }));
                await this.#enqueue(async () => {
                    await this.#context.emit({ entries, sessionUpdate: "plan" });
                });
            }
            return;
        }
        if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (
                decoded.success &&
                decoded.data.threadId === this.#context.threadId() &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                this.#streamedReasoningItemIds.add(decoded.data.itemId);
                await this.#enqueue(async () => {
                    await this.#context.emit({
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
                decoded.data.threadId === this.#context.threadId() &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                const phase = this.#agentMessages.get(decoded.data.itemId)?.phase;
                this.#agentMessages.set(decoded.data.itemId, { phase, kind: "streaming" });
                await this.#enqueue(async () => {
                    await this.#context.emit(agentMessageUpdate(decoded.data.itemId, decoded.data.delta, phase));
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
                await this.#context.emit(agentMessageUpdate(item.id, item.text, item.phase));
            });
            return;
        }
        if (item.type === "contextCompaction") {
            // The item id doubles as the ACP compaction id: started opens the
            // compaction, completed settles it. Codex exposes no streamed summary,
            // so no compaction_summary_chunk follows. Both automatic compactions
            // and manual /compact surface here exactly once.
            await this.#enqueue(async () => {
                await this.#context.emit({
                    compactionId: item.id,
                    sessionUpdate: "compaction_update",
                    status: method === "item/completed" ? "completed" : "in_progress",
                });
                if (method === "item/completed") {
                    this.#onCompactionItemSettled?.();
                }
            });
            return;
        }
        const reasoning = reasoningText(item);
        if (reasoning !== null) {
            const streamed = method === "item/completed" && this.#streamedReasoningItemIds.delete(item.id);
            if (method === "item/completed" && reasoning.length > 0 && !streamed) {
                await this.#enqueue(async () => {
                    await this.#context.emit({
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
                if (method === "item/started") {
                    await this.#context.emit({ ...update, sessionUpdate: "tool_call" });
                } else {
                    await this.#context.emit({ ...update, sessionUpdate: "tool_call_update" });
                }
            });
        }
    };

    readonly onServerRequest = async (request: CodexAppServerServerRequest): Promise<void> => {
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
        const connection = this.#context.connection();
        if (connection === null) {
            return "cancel";
        }
        const response = await connection.client.request(
            methods.client.session.requestPermission,
            {
                options: [...APPROVAL_OPTIONS],
                sessionId: this.#context.threadId(),
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
        const connection = this.#context.connection();
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
                sessionId: this.#context.threadId(),
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
        const connection = this.#context.connection();
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
                    elicitationId: `${this.#context.threadId()}-${String(request.id)}`,
                    message: params.message,
                    mode: "url",
                    sessionId: this.#context.threadId(),
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
                sessionId: this.#context.threadId(),
            },
            { cancellationSignal: signal },
        );
        const content = response.action === "accept" ? (Reflect.get(response, "content") ?? null) : null;
        this.#appServer.respond(request.id, { action: response.action, content });
    };

    readonly prompt = async (input: readonly unknown[], signal: AbortSignal): Promise<PromptResponse> => {
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
            void this.#context.close().catch((cause: unknown) => {
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
                            threadId: this.#context.threadId(),
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

    readonly steer = async (
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
        if (sessionId !== this.#context.threadId() || active === null || active.turn.id.length === 0) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const steering = steeringPrompt(prompt);
        if (steering.length === 0) {
            throw new AcpExecutionError("Codex received an empty steering request", {}, "invalid_request");
        }
        const response = turnSteerResponseSchema.parse(
            await this.#appServer.request(
                "turn/steer",
                {
                    expectedTurnId: active.turn.id,
                    input: steering.map((block) => block.input),
                    threadId: this.#context.threadId(),
                },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            ),
        );
        if (response.turnId !== active.turn.id) {
            throw new AcpExecutionError("Codex steered an unexpected turn", {}, "steering_target_unavailable");
        }
        return { outcome: "injected" };
    };

    readonly cancel = async (): Promise<void> => {
        const turn = this.#turn;
        if (turn === null) {
            return;
        }
        this.#turn = null;
        if (turn.turn.id.length > 0) {
            try {
                await this.#appServer.request(
                    "turn/interrupt",
                    { threadId: this.#context.threadId(), turnId: turn.turn.id },
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
        readonly id: string;
        readonly status: string;
    }): Promise<void> => {
        const active = this.#turn;
        if (active === null || active.turn.id !== turn.id) {
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
