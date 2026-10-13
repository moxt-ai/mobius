import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
    SessionHistoryPageRequestV3,
    SessionHistoryPageV3,
    SessionPermissionResponseV3,
    SessionSettingChangeV3,
    SessionSettingsV3,
    SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import type { NativeAgentLaunchV3, NativeSessionLiveRuntimeV3 } from "../../runtime-manager-v3.ts";
import {
    type ConnectedNativeSessionV3,
    type NativeSessionContextV3,
    NativeSessionOperationErrorV3,
    type NativeSessionPromptResultV3,
    type NativeSessionPromptV3,
    type NativeSessionTerminationV3,
} from "../adapter-v3.ts";
import { PiNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

const persistedMessageSchema = z.object({
    id: z.string().min(1).max(2_048),
    message: z.discriminatedUnion("role", [
        z.object({
            content: z.union([z.string(), z.array(z.unknown()).max(1_000)]),
            role: z.literal("user"),
        }),
        z.object({
            content: z.array(z.unknown()).max(1_000),
            role: z.literal("assistant"),
        }),
        z.object({ role: z.literal("toolResult") }).passthrough(),
    ]),
    type: z.literal("message"),
});
const textBlockSchema = z.object({ text: z.string(), type: z.literal("text") });
const thinkingBlockSchema = z.object({ thinking: z.string(), type: z.literal("thinking") });
const toolCallBlockSchema = z.object({ id: z.string(), name: z.string(), type: z.literal("toolCall") });
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function agentDirectory(agent: NativeAgentLaunchV3): string | undefined {
    return (
        agent.environment["PI_CODING_AGENT_DIR"] ??
        (agent.environment["HOME"] === undefined ? undefined : join(agent.environment["HOME"], ".pi", "agent"))
    );
}

function sessionDirectory(agent: NativeAgentLaunchV3): string | undefined {
    const directory = agentDirectory(agent);
    return (
        agent.environment["PI_CODING_AGENT_SESSION_DIR"] ??
        (directory === undefined ? undefined : join(directory, "sessions"))
    );
}

async function createModelRuntime(
    agent: NativeAgentLaunchV3,
    directory: string | undefined,
    signal: AbortSignal,
): Promise<ModelRuntime | undefined> {
    if (directory === undefined) {
        return undefined;
    }
    const runtime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: join(directory, "models.json"),
        signal,
    });
    for (const [providerId, variable] of [
        ["anthropic", "ANTHROPIC_API_KEY"],
        ["google", "GEMINI_API_KEY"],
        ["openai", "OPENAI_API_KEY"],
        ["xai", "XAI_API_KEY"],
    ] as const) {
        const apiKey = agent.environment[variable];
        if (apiKey !== undefined) {
            await runtime.setRuntimeApiKey(providerId, apiKey, { signal });
        }
    }
    return runtime;
}

function promptText(prompt: NativeSessionPromptV3): string {
    return [
        prompt.prompt,
        ...prompt.resources.map((resource) =>
            resource.type === "embedded"
                ? `Resource ${resource.name}:\n${resource.text}`
                : `Resource ${resource.name}: ${resource.uri}\n${resource.text}`,
        ),
    ]
        .filter((part) => part.length > 0)
        .join("\n\n");
}

export class ConnectedPiSessionV3 implements ConnectedNativeSessionV3 {
    readonly #context: NativeSessionContextV3;
    readonly #history: PiNativeSessionPreviewAdapterV3;
    readonly #live: NativeSessionLiveRuntimeV3;
    readonly #publishedEntryIds = new Set<string>();
    readonly #session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    readonly #sessionManager: SessionManager;
    readonly #termination = Promise.withResolvers<NativeSessionTerminationV3>();
    readonly #unsubscribe: () => void;
    #closed = false;
    #cancellationRequested = false;
    #publication: Promise<void> = Promise.resolve();

    readonly nativeSessionId: string;

    constructor(
        context: NativeSessionContextV3,
        live: NativeSessionLiveRuntimeV3,
        session: Awaited<ReturnType<typeof createAgentSession>>["session"],
        sessionManager: SessionManager,
        history: PiNativeSessionPreviewAdapterV3,
    ) {
        this.#context = context;
        this.#history = history;
        this.#live = live;
        this.#session = session;
        this.#sessionManager = sessionManager;
        for (const entry of sessionManager.getEntries()) {
            this.#publishedEntryIds.add(entry.id);
        }
        this.nativeSessionId = context.nativeSessionId;
        this.#unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end") {
                this.#publication = this.#publication
                    .then(async () => await this.#publishNewEntries())
                    .catch((cause: unknown) => {
                        console.error("Mobius daemon could not publish a Pi Session entry", cause);
                    });
            }
        });
    }

    readonly #publishNewEntries = async (): Promise<void> => {
        for (const entry of this.#sessionManager.getEntries()) {
            if (this.#publishedEntryIds.has(entry.id)) {
                continue;
            }
            this.#publishedEntryIds.add(entry.id);
            await this.#publishEntry(entry);
        }
    };

    readonly #publishEntry = async (entry: SessionEntry): Promise<void> => {
        const decoded = persistedMessageSchema.safeParse(entry);
        if (!decoded.success || decoded.data.message.role === "toolResult") {
            return;
        }
        const { message } = decoded.data;
        const blocks =
            typeof message.content === "string" ? [{ text: message.content, type: "text" }] : message.content;
        for (const block of blocks) {
            const text = textBlockSchema.safeParse(block);
            if (text.success) {
                await this.#live.publish({
                    content: { text: text.data.text, type: "text" },
                    messageId: decoded.data.id,
                    sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                });
                continue;
            }
            const thinking = thinkingBlockSchema.safeParse(block);
            if (thinking.success && message.role === "assistant") {
                await this.#live.publish({
                    content: { text: thinking.data.thinking, type: "text" },
                    messageId: decoded.data.id,
                    sessionUpdate: "agent_thought_chunk",
                });
                continue;
            }
            const tool = toolCallBlockSchema.safeParse(block);
            if (tool.success && message.role === "assistant") {
                await this.#live.publish({
                    messageId: decoded.data.id,
                    name: tool.data.name,
                    sessionUpdate: "tool_call",
                    status: "pending",
                    title: tool.data.name,
                    toolCallId: tool.data.id,
                });
            }
        }
    };

    readonly pageMessages = async (
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<SessionHistoryPageV3> => {
        const page = await this.#history.previewMessages(this.#context, request, signal);
        return { ...page, throughSeq: this.#live.readThroughSeq() };
    };

    readonly readSettings = async (signal: AbortSignal): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        return {
            settings: [
                ...(this.#session.model === undefined
                    ? []
                    : [{ id: "model", name: "Model", value: this.#session.model.id }]),
                { id: "thinking_level", name: "Thinking level", value: this.#session.thinkingLevel },
            ],
        };
    };

    readonly cancelPrompt = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        this.#cancellationRequested = true;
        await this.#session.abort();
    };

    readonly applySetting = async (change: SessionSettingChangeV3, signal: AbortSignal): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        if (change.settingId !== "thinking_level" || typeof change.value !== "string") {
            throw new NativeSessionOperationErrorV3("native_session_unsupported", "This Pi setting cannot be changed");
        }
        const level = thinkingLevels.find((candidate) => candidate === change.value);
        if (level === undefined) {
            throw new NativeSessionOperationErrorV3("invalid_request", "The Pi thinking level is invalid");
        }
        this.#session.setThinkingLevel(level);
        return await this.readSettings(signal);
    };

    readonly runPrompt = async (
        prompt: NativeSessionPromptV3,
        signal: AbortSignal,
    ): Promise<NativeSessionPromptResultV3> => {
        signal.throwIfAborted();
        if (this.#closed) {
            throw new NativeSessionOperationErrorV3("native_session_closed", "The Pi Session is closed");
        }
        if (this.#session.isStreaming) {
            throw new NativeSessionOperationErrorV3("session_busy", "Another prompt is already running");
        }
        const abort = (): void => {
            void this.#session.abort();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#session.prompt(promptText(prompt), {
                images: prompt.images.map((image) => ({ data: image.data, mimeType: image.mimeType, type: "image" })),
            });
            await this.#publication;
            signal.throwIfAborted();
            return { stopReason: this.#cancellationRequested ? "cancelled" : "end_turn" };
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
            this.#cancellationRequested = false;
        }
    };

    readonly respondPermission = async (_response: SessionPermissionResponseV3, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        throw new NativeSessionOperationErrorV3("stale_interaction", "The permission request is no longer pending");
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
        await this.#session.abort();
        await this.#publication;
        this.#unsubscribe();
        this.#session.dispose();
        this.#termination.resolve({ kind: "closed" });
    };
}

export async function connectPiNativeSessionV3(
    agent: NativeAgentLaunchV3,
    context: NativeSessionContextV3,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> {
    signal.throwIfAborted();
    const directory = sessionDirectory(agent);
    const agentDir = agentDirectory(agent);
    const modelRuntime = await createModelRuntime(agent, agentDir, signal);
    const path = SessionManager.findById(context.cwd, context.nativeSessionId, directory);
    if (path === undefined) {
        throw new NativeSessionOperationErrorV3("session_not_found", "The Pi Session was not found");
    }
    const sessionManager = SessionManager.open(path, directory, context.cwd);
    const result = await createAgentSession({
        ...(agentDir === undefined ? {} : { agentDir }),
        cwd: context.cwd,
        ...(modelRuntime === undefined ? {} : { modelRuntime }),
        sessionManager,
    });
    signal.throwIfAborted();
    return new ConnectedPiSessionV3(
        context,
        live,
        result.session,
        sessionManager,
        new PiNativeSessionPreviewAdapterV3(directory),
    );
}

export async function createPiNativeSessionV3(
    agent: NativeAgentLaunchV3,
    context: Omit<NativeSessionContextV3, "nativeSessionId">,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> {
    signal.throwIfAborted();
    const directory = sessionDirectory(agent);
    const agentDir = agentDirectory(agent);
    const modelRuntime = await createModelRuntime(agent, agentDir, signal);
    const nativeSessionId = randomUUID();
    const sessionManager = SessionManager.create(context.cwd, directory, { id: nativeSessionId });
    const result = await createAgentSession({
        ...(agentDir === undefined ? {} : { agentDir }),
        cwd: context.cwd,
        ...(modelRuntime === undefined ? {} : { modelRuntime }),
        sessionManager,
    });
    signal.throwIfAborted();
    return new ConnectedPiSessionV3(
        { ...context, nativeSessionId },
        live,
        result.session,
        sessionManager,
        new PiNativeSessionPreviewAdapterV3(directory),
    );
}
