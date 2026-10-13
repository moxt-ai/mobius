import { randomUUID } from "node:crypto";
import {
    type PermissionResult,
    type Query,
    query,
    type SDKAssistantMessage,
    type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
    SessionHistoryPageRequestV3,
    SessionHistoryPageV3,
    SessionPermissionResponseV3,
    SessionSettingChangeV3,
    SessionSettingsV3,
    SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";
import type { NativeAgentLaunchV3, NativeSessionLiveRuntimeV3 } from "../../runtime-manager-v3.ts";
import {
    type ConnectedNativeSessionV3,
    type NativeSessionContextV3,
    NativeSessionOperationErrorV3,
    type NativeSessionPromptResultV3,
    type NativeSessionPromptV3,
    type NativeSessionTerminationV3,
} from "../adapter-v3.ts";
import { ClaudeNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

const permissionOptions = [
    { kind: "allow_once", name: "Allow once", optionId: "allow_once" },
    { kind: "allow_always", name: "Always allow", optionId: "allow_always" },
    { kind: "reject_once", name: "Deny", optionId: "reject_once" },
] as const;

interface PendingPermission {
    readonly completion: PromiseWithResolvers<PermissionResult>;
    readonly input: Record<string, unknown>;
}

function promptText(prompt: NativeSessionPromptV3): string {
    return [
        prompt.prompt,
        ...prompt.images.map((image) => `[Image: ${image.name} (${image.mimeType})]`),
        ...prompt.resources.map((resource) =>
            resource.type === "embedded"
                ? `Resource ${resource.name}:\n${resource.text}`
                : `Resource ${resource.name}: ${resource.uri}\n${resource.text}`,
        ),
    ]
        .filter((part) => part.length > 0)
        .join("\n\n");
}

export class ConnectedClaudeSessionV3 implements ConnectedNativeSessionV3 {
    readonly #agent: NativeAgentLaunchV3;
    readonly #context: NativeSessionContextV3;
    readonly #history: ClaudeNativeSessionPreviewAdapterV3;
    readonly #live: NativeSessionLiveRuntimeV3;
    readonly #pending = new Map<string, PendingPermission>();
    readonly #termination = Promise.withResolvers<NativeSessionTerminationV3>();
    #active: Query | null = null;
    #closed = false;
    #cancellationRequested = false;
    #newSession: boolean;

    readonly nativeSessionId: string;

    constructor(
        agent: NativeAgentLaunchV3,
        context: NativeSessionContextV3,
        live: NativeSessionLiveRuntimeV3,
        newSession = false,
    ) {
        this.#agent = agent;
        this.#context = context;
        this.#history = new ClaudeNativeSessionPreviewAdapterV3(agent.environment["CLAUDE_CONFIG_DIR"]);
        this.#live = live;
        this.#newSession = newSession;
        this.nativeSessionId = context.nativeSessionId;
    }

    readonly pageMessages = async (
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<SessionHistoryPageV3> => {
        const page = await this.#history.previewMessages(this.#context, request, signal);
        return { ...page, throughSeq: this.#live.readThroughSeq() };
    };

    readonly readSettings = async (signal: AbortSignal): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        return { settings: [] };
    };

    readonly cancelPrompt = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        this.#cancellationRequested = true;
        this.#active?.close();
    };

    readonly applySetting = async (
        _change: SessionSettingChangeV3,
        signal: AbortSignal,
    ): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        throw new NativeSessionOperationErrorV3("native_session_unsupported", "Claude setting changes are unavailable");
    };

    readonly #permission = async (
        toolName: string,
        input: Record<string, unknown>,
        options: { readonly signal: AbortSignal; readonly title?: string; readonly toolUseID: string },
    ): Promise<PermissionResult> => {
        const requestId = randomUUID();
        const completion = Promise.withResolvers<PermissionResult>();
        this.#pending.set(requestId, { completion, input });
        const abort = (): void => completion.reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#live.publish({
                options: permissionOptions,
                requestId,
                sessionUpdate: "permission_requested",
                title: options.title ?? `Claude wants to use ${toolName}`,
                toolCallId: options.toolUseID,
            });
            return await completion.promise;
        } finally {
            options.signal.removeEventListener("abort", abort);
            this.#pending.delete(requestId);
        }
    };

    readonly #publishAssistant = async (message: SDKAssistantMessage): Promise<void> => {
        for (const block of message.message.content) {
            if (block.type === "text") {
                await this.#live.publish({
                    content: { text: block.text, type: "text" },
                    messageId: message.uuid,
                    sessionUpdate: "agent_message_chunk",
                });
                continue;
            }
            if (block.type === "thinking") {
                await this.#live.publish({
                    content: { text: block.thinking, type: "text" },
                    messageId: message.uuid,
                    sessionUpdate: "agent_thought_chunk",
                });
                continue;
            }
            if (block.type === "tool_use") {
                await this.#live.publish({
                    messageId: message.uuid,
                    name: block.name,
                    sessionUpdate: "tool_call",
                    status: "pending",
                    title: block.name,
                    toolCallId: block.id,
                });
            }
        }
    };

    readonly runPrompt = async (
        prompt: NativeSessionPromptV3,
        signal: AbortSignal,
    ): Promise<NativeSessionPromptResultV3> => {
        signal.throwIfAborted();
        if (this.#closed) {
            throw new NativeSessionOperationErrorV3("native_session_closed", "The Claude Session is closed");
        }
        if (this.#active !== null) {
            throw new NativeSessionOperationErrorV3("session_busy", "Another prompt is already running");
        }
        const newSession = this.#newSession;
        const running = query({
            options: {
                additionalDirectories: [...this.#context.additionalDirectories],
                canUseTool: async (toolName, input, options) => await this.#permission(toolName, input, options),
                cwd: this.#context.cwd,
                env: { ...process.env, ...this.#agent.environment },
                pathToClaudeCodeExecutable: this.#agent.command,
                ...(newSession ? { sessionId: this.nativeSessionId } : { resume: this.nativeSessionId }),
                settingSources: ["user", "project", "local"],
            },
            prompt: promptText(prompt),
        });
        const abort = (): void => running.close();
        signal.addEventListener("abort", abort, { once: true });
        this.#active = running;
        let failed: string | null = null;
        try {
            for await (const message of running as AsyncIterable<SDKMessage>) {
                signal.throwIfAborted();
                if (message.type === "assistant") {
                    await this.#publishAssistant(message);
                } else if (message.type === "result" && message.is_error) {
                    failed = message.subtype === "success" ? message.result : message.errors.join("\n");
                }
            }
            this.#newSession = false;
            if (this.#cancellationRequested) {
                return { stopReason: "cancelled" };
            }
            if (failed !== null) {
                throw new NativeSessionOperationErrorV3("native_turn_failed", failed);
            }
            return { stopReason: "end_turn" };
        } catch (cause) {
            if (this.#cancellationRequested) {
                return { stopReason: "cancelled" };
            }
            if (signal.aborted) {
                throw signal.reason;
            }
            throw cause;
        } finally {
            signal.removeEventListener("abort", abort);
            running.close();
            if (this.#active === running) {
                this.#active = null;
            }
            this.#cancellationRequested = false;
        }
    };

    readonly respondPermission = async (response: SessionPermissionResponseV3, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const pending = this.#pending.get(response.requestId);
        if (pending === undefined) {
            throw new NativeSessionOperationErrorV3("stale_interaction", "The permission request is no longer pending");
        }
        const allowed = response.optionId.startsWith("allow");
        pending.completion.resolve(
            allowed
                ? { behavior: "allow", updatedInput: pending.input }
                : { behavior: "deny", message: "The user denied this operation" },
        );
        await this.#live.publish({
            outcome: "selected",
            requestId: response.requestId,
            selectedOptionId: response.optionId,
            sessionUpdate: "permission_resolved",
        });
    };

    readonly respondUserInput = async (_response: SessionUserInputResponseV3, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        throw new NativeSessionOperationErrorV3("stale_interaction", "The user-input request is no longer pending");
    };

    readonly waitForTermination = async (signal: AbortSignal): Promise<NativeSessionTerminationV3> => {
        signal.throwIfAborted();
        const cancelled = Promise.withResolvers<never>();
        const abort = (): void => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            return await Promise.race([this.#termination.promise, cancelled.promise]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };

    readonly close = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#active?.close();
        for (const pending of this.#pending.values()) {
            pending.completion.resolve({ behavior: "deny", message: "The Session closed" });
        }
        this.#pending.clear();
        this.#termination.resolve({ kind: "closed" });
    };
}

export const connectClaudeNativeSessionV3 = async (
    agent: NativeAgentLaunchV3,
    context: NativeSessionContextV3,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> => {
    signal.throwIfAborted();
    return new ConnectedClaudeSessionV3(agent, context, live);
};

export const createClaudeNativeSessionV3 = async (
    agent: NativeAgentLaunchV3,
    context: Omit<NativeSessionContextV3, "nativeSessionId">,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> => {
    signal.throwIfAborted();
    return new ConnectedClaudeSessionV3(agent, { ...context, nativeSessionId: randomUUID() }, live, true);
};
