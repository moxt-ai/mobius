import type {
    SessionHistoryItemV3,
    SessionHistoryMessageV3,
    SessionHistoryPageRequestV3,
    SessionHistoryPageV3,
    SessionLiveEventItemV3,
    SessionPermissionResponseV3,
    SessionSettingChangeV3,
    SessionSettingsV3,
    SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../../process/executable.ts";
import type { NativeAgentLaunchV3, NativeSessionLiveRuntimeV3 } from "../../runtime-manager-v3.ts";
import {
    type ConnectedNativeSessionV3,
    type NativeSessionContextV3,
    NativeSessionOperationErrorV3,
    type NativeSessionPromptResultV3,
    type NativeSessionPromptV3,
    type NativeSessionTerminationV3,
} from "../adapter-v3.ts";
import { CodexAppServerClient, type CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    reasoningTextDeltaParamsSchema,
    requestUserInputParamsSchema,
    threadItemSchema,
    threadResumeResponseSchema,
    threadStartResponseSchema,
    turnNotificationSchema,
    turnSchema,
} from "./app-server-protocol.ts";
import { CodexHistoryAdapterV3, projectCodexHistoryMessageV3 } from "./history-v3.ts";

const itemNotificationSchema = z.object({
    item: z.unknown(),
    threadId: z.string().min(1).max(256),
});

type PendingInteractionV3 =
    | {
          readonly kind: "permission";
          readonly nativeRequestId: number | string;
      }
    | {
          readonly kind: "user-input";
          readonly nativeRequestId: number | string;
          readonly questionIds: readonly string[];
      };

type CodexTurnV3 =
    | { readonly kind: "idle" }
    | {
          readonly completion: PromiseWithResolvers<NativeSessionPromptResultV3>;
          readonly kind: "starting";
          readonly cancellationRequested: boolean;
      }
    | {
          readonly completion: PromiseWithResolvers<NativeSessionPromptResultV3>;
          readonly kind: "running";
          readonly cancellationRequested: boolean;
          readonly turnId: string;
      };

function promptInput(prompt: NativeSessionPromptV3): readonly unknown[] {
    return [
        { text: prompt.prompt, text_elements: [], type: "text" },
        ...prompt.images.map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
        ...prompt.resources.map((resource) => ({
            text: resource.type === "embedded" ? resource.text : `Resource: ${resource.uri}\n${resource.text}`,
            text_elements: [],
            type: "text",
        })),
    ];
}

class SessionLaneV3 {
    #tail = Promise.resolve();

    readonly run = async <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = this.#tail.then(operation, operation);
        this.#tail = pending.then(
            () => undefined,
            () => undefined,
        );
        return await pending;
    };
}

function appendText(
    message: SessionHistoryMessageV3 | undefined,
    item: SessionLiveEventItemV3,
): SessionHistoryMessageV3 | null {
    if (
        item.sessionUpdate !== "user_message_chunk" &&
        item.sessionUpdate !== "agent_message_chunk" &&
        item.sessionUpdate !== "agent_thought_chunk"
    ) {
        return null;
    }
    const sessionUpdate =
        item.sessionUpdate === "user_message_chunk"
            ? "user_message"
            : item.sessionUpdate === "agent_message_chunk"
              ? "agent_message"
              : "agent_thought";
    const prior = message?.item.sessionUpdate === sessionUpdate ? message.item.content : [];
    const last = prior[prior.length - 1];
    const content =
        item.content.type === "text" && last?.type === "text"
            ? [
                  ...prior.slice(0, -1),
                  {
                      ...last,
                      text: `${last.text}${item.content.text}`,
                      type: "text" as const,
                  },
              ]
            : [...prior, item.content];
    return {
        item: { content, sessionUpdate },
        messageId: item.messageId,
        sessionId: message?.sessionId ?? "",
    };
}

function completeItem(item: SessionLiveEventItemV3): SessionHistoryItemV3 | null {
    if (item.sessionUpdate === "tool_call" || item.sessionUpdate === "tool_call_update") {
        return {
            ...(item.content === undefined ? {} : { content: item.content }),
            ...(item.kind === undefined ? {} : { kind: item.kind }),
            ...(item.locations === undefined ? {} : { locations: item.locations }),
            ...(item.name === undefined ? {} : { name: item.name }),
            ...(item.status === undefined ? {} : { status: item.status }),
            title: item.title ?? item.name ?? "Tool",
            toolCallId: item.toolCallId,
            sessionUpdate: "tool_call",
        };
    }
    if (item.sessionUpdate === "plan") {
        return { entries: item.entries, sessionUpdate: "plan" };
    }
    return null;
}

function approvalDecision(optionId: string): "accept" | "acceptForSession" | "cancel" | "decline" {
    if (optionId === "allow_once") {
        return "accept";
    }
    if (optionId === "allow_always") {
        return "acceptForSession";
    }
    if (optionId === "reject_once" || optionId === "reject_always") {
        return "decline";
    }
    return "cancel";
}

export class ConnectedCodexSessionV3 implements ConnectedNativeSessionV3 {
    readonly #appServer: CodexAppServerClient;
    readonly #history: CodexHistoryAdapterV3;
    readonly #lane = new SessionLaneV3();
    readonly #live: NativeSessionLiveRuntimeV3;
    readonly #liveMessages = new Map<string, SessionHistoryMessageV3>();
    readonly #pending = new Map<string, PendingInteractionV3>();
    readonly #sessionId: string;
    readonly #settings: SessionSettingsV3;
    #closed = false;
    #turn: CodexTurnV3 = { kind: "idle" };
    readonly nativeSessionId: string;

    constructor(
        appServer: CodexAppServerClient,
        session: NativeSessionContextV3,
        live: NativeSessionLiveRuntimeV3,
        settings: SessionSettingsV3,
    ) {
        this.#appServer = appServer;
        this.#history = new CodexHistoryAdapterV3(appServer);
        this.#live = live;
        this.#sessionId = session.sessionId;
        this.#settings = settings;
        this.nativeSessionId = session.nativeSessionId;
    }

    readonly #publish = async (item: SessionLiveEventItemV3): Promise<void> => {
        await this.#live.publish(item);
        const messageId = "messageId" in item ? item.messageId : undefined;
        if (messageId === undefined) {
            return;
        }
        const appended = appendText(this.#liveMessages.get(messageId), item);
        if (appended !== null) {
            this.#liveMessages.set(messageId, { ...appended, sessionId: this.#sessionId });
            return;
        }
        const complete = completeItem(item);
        if (complete !== null) {
            this.#liveMessages.set(messageId, { item: complete, messageId, sessionId: this.#sessionId });
        }
    };

    readonly onNotification = async (method: string, params: unknown): Promise<void> => {
        if (method === "turn/started") {
            const notification = turnNotificationSchema.safeParse(params);
            if (!notification.success || notification.data.threadId !== this.nativeSessionId) {
                return;
            }
            const turn = this.#turn;
            if (turn.kind === "starting") {
                this.#turn = {
                    cancellationRequested: turn.cancellationRequested,
                    completion: turn.completion,
                    kind: "running",
                    turnId: notification.data.turn.id,
                };
                if (turn.cancellationRequested) {
                    void this.#interrupt(notification.data.turn.id, AbortSignal.timeout(30_000));
                }
            }
            return;
        }
        if (method === "turn/completed") {
            const notification = turnNotificationSchema.safeParse(params);
            if (!notification.success || notification.data.threadId !== this.nativeSessionId) {
                return;
            }
            const turn = this.#turn;
            if (turn.kind === "idle" || (turn.kind === "running" && turn.turnId !== notification.data.turn.id)) {
                return;
            }
            await this.#lane.run(async () => undefined);
            if (this.#turn !== turn) {
                return;
            }
            this.#turn = { kind: "idle" };
            if (notification.data.turn.status === "failed") {
                turn.completion.reject(
                    new NativeSessionOperationErrorV3(
                        "native_turn_failed",
                        notification.data.turn.error?.message ?? "The Codex turn failed",
                    ),
                );
            } else {
                turn.completion.resolve({
                    stopReason: notification.data.turn.status === "interrupted" ? "cancelled" : "end_turn",
                });
            }
            return;
        }
        if (
            method === "item/agentMessage/delta" ||
            method === "item/reasoning/summaryTextDelta" ||
            method === "item/reasoning/textDelta"
        ) {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (!decoded.success || decoded.data.threadId !== this.nativeSessionId || decoded.data.delta.length === 0) {
                return;
            }
            await this.#lane.run(
                async () =>
                    await this.#publish({
                        content: { text: decoded.data.delta, type: "text" },
                        messageId: decoded.data.itemId,
                        sessionUpdate:
                            method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk",
                    }),
            );
            return;
        }
        if (method !== "item/started" && method !== "item/completed") {
            return;
        }
        const notification = itemNotificationSchema.safeParse(params);
        if (!notification.success || notification.data.threadId !== this.nativeSessionId) {
            return;
        }
        const nativeItem = threadItemSchema.safeParse(notification.data.item);
        if (!nativeItem.success) {
            return;
        }
        const projected = projectCodexHistoryMessageV3(this.#sessionId, nativeItem.data);
        await this.#lane.run(async () => {
            const item = projected.item;
            if (
                item.sessionUpdate === "user_message" ||
                item.sessionUpdate === "agent_message" ||
                item.sessionUpdate === "agent_thought"
            ) {
                if (method === "item/started") {
                    return;
                }
                for (const content of item.content) {
                    await this.#publish({
                        content,
                        messageId: projected.messageId,
                        sessionUpdate:
                            item.sessionUpdate === "user_message"
                                ? "user_message_chunk"
                                : item.sessionUpdate === "agent_message"
                                  ? "agent_message_chunk"
                                  : "agent_thought_chunk",
                    });
                }
                return;
            }
            if (item.sessionUpdate === "tool_call") {
                await this.#publish({
                    ...item,
                    messageId: projected.messageId,
                    sessionUpdate: method === "item/started" ? "tool_call" : "tool_call_update",
                });
                return;
            }
            if (method === "item/completed") {
                await this.#publish({ ...item, messageId: projected.messageId });
            }
        });
    };

    readonly onServerRequest = async (request: CodexAppServerServerRequest): Promise<void> => {
        if (
            request.method === "item/commandExecution/requestApproval" ||
            request.method === "item/fileChange/requestApproval"
        ) {
            const decoded =
                request.method === "item/commandExecution/requestApproval"
                    ? commandApprovalParamsSchema.safeParse(request.params)
                    : fileChangeApprovalParamsSchema.safeParse(request.params);
            if (!decoded.success || decoded.data.threadId !== this.nativeSessionId) {
                this.#appServer.respondWithError(request.id, -32_602, "Mobius could not read the approval request");
                return;
            }
            const requestId = String(request.id);
            const command = "command" in decoded.data ? decoded.data.command : null;
            this.#pending.set(requestId, { kind: "permission", nativeRequestId: request.id });
            await this.#lane.run(
                async () =>
                    await this.#publish({
                        options: [
                            { kind: "allow_once", name: "Allow once", optionId: "allow_once" },
                            { kind: "allow_always", name: "Allow for Session", optionId: "allow_always" },
                            { kind: "reject_once", name: "Reject", optionId: "reject_once" },
                        ],
                        requestId,
                        sessionUpdate: "permission_requested",
                        title: command ?? decoded.data.reason ?? "Approve a local change",
                        toolCallId: decoded.data.itemId,
                    }),
            );
            return;
        }
        if (request.method === "item/tool/requestUserInput") {
            const decoded = requestUserInputParamsSchema.safeParse(request.params);
            if (!decoded.success || decoded.data.threadId !== this.nativeSessionId) {
                this.#appServer.respondWithError(request.id, -32_602, "Mobius could not read the user-input request");
                return;
            }
            const requestId = String(request.id);
            this.#pending.set(requestId, {
                kind: "user-input",
                nativeRequestId: request.id,
                questionIds: decoded.data.questions.map((question) => question.id),
            });
            await this.#lane.run(
                async () =>
                    await this.#publish({
                        fields: decoded.data.questions.map((question) => ({
                            name: question.id,
                            ...(question.options == null
                                ? {}
                                : {
                                      options: question.options.map((option) => ({
                                          description: option.description,
                                          label: option.label,
                                          value: option.label,
                                      })),
                                  }),
                            required: true,
                            title: question.header,
                            type: question.options == null ? "string" : "select",
                        })),
                        message: decoded.data.questions.map((question) => question.question).join("\n\n"),
                        requestId,
                        sessionUpdate: "user_input_requested",
                        ...(decoded.data.itemId == null ? {} : { toolCallId: decoded.data.itemId }),
                    }),
            );
            return;
        }
        this.#appServer.respondWithError(request.id, -32_601, `Mobius does not support ${request.method}`);
    };

    readonly pageMessages = async (
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<SessionHistoryPageV3> => {
        const nativePage = await this.#history.page(this.nativeSessionId, request, signal);
        signal.throwIfAborted();
        return await this.#lane.run(async () => {
            const authoritative = new Set(nativePage.messages.map((message) => message.messageId));
            const live =
                request.cursor === null
                    ? [...this.#liveMessages.values()].filter((message) => !authoritative.has(message.messageId))
                    : [];
            return {
                messages: [...nativePage.messages, ...live].slice(0, request.messageLimit),
                nextCursor: nativePage.nextCursor,
                throughSeq: this.#live.readThroughSeq(),
            };
        });
    };

    readonly readSettings = async (signal: AbortSignal): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        return this.#settings;
    };

    readonly #interrupt = async (turnId: string, signal: AbortSignal): Promise<void> => {
        await this.#appServer.request("turn/interrupt", { threadId: this.nativeSessionId, turnId }, signal);
    };

    readonly cancelPrompt = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const turn = this.#turn;
        if (turn.kind === "idle") {
            return;
        }
        this.#turn = { ...turn, cancellationRequested: true };
        if (turn.kind === "running") {
            await this.#interrupt(turn.turnId, signal);
        }
    };

    readonly runPrompt = async (
        prompt: NativeSessionPromptV3,
        signal: AbortSignal,
    ): Promise<NativeSessionPromptResultV3> => {
        signal.throwIfAborted();
        if (this.#turn.kind !== "idle") {
            throw new NativeSessionOperationErrorV3("session_busy", "Another prompt is already running");
        }
        const completion = Promise.withResolvers<NativeSessionPromptResultV3>();
        void completion.promise.catch(() => undefined);
        this.#turn = { cancellationRequested: false, completion, kind: "starting" };
        const cancel = (): void => {
            const active = this.#turn;
            if (active.kind === "idle" || active.completion !== completion) {
                return;
            }
            this.#turn = { kind: "idle" };
            if (active.kind === "running") {
                void this.#interrupt(active.turnId, AbortSignal.timeout(30_000)).catch(() => undefined);
            }
            completion.reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const started = z
                .object({ turn: turnSchema })
                .parse(
                    await this.#appServer.request(
                        "turn/start",
                        { input: promptInput(prompt), threadId: this.nativeSessionId },
                        signal,
                    ),
                ).turn;
            const active = this.#turn;
            if (active.kind === "starting" && active.completion === completion) {
                this.#turn = {
                    cancellationRequested: active.cancellationRequested,
                    completion,
                    kind: "running",
                    turnId: started.id,
                };
                if (active.cancellationRequested) {
                    void this.#interrupt(started.id, AbortSignal.timeout(30_000));
                }
            }
            return await completion.promise;
        } finally {
            signal.removeEventListener("abort", cancel);
            const active = this.#turn;
            if ("completion" in active && active.completion === completion) {
                this.#turn = { kind: "idle" };
            }
        }
    };

    readonly applySetting = async (
        _change: SessionSettingChangeV3,
        signal: AbortSignal,
    ): Promise<SessionSettingsV3> => {
        signal.throwIfAborted();
        throw new NativeSessionOperationErrorV3("native_session_unsupported", "Codex setting changes are unavailable");
    };

    readonly respondPermission = async (response: SessionPermissionResponseV3, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (response.sessionId !== this.#sessionId) {
            throw new NativeSessionOperationErrorV3("stale_interaction", "The permission request is no longer pending");
        }
        const pending = this.#pending.get(response.requestId);
        if (pending?.kind !== "permission") {
            throw new NativeSessionOperationErrorV3("stale_interaction", "The permission request is no longer pending");
        }
        this.#pending.delete(response.requestId);
        this.#appServer.respond(pending.nativeRequestId, { decision: approvalDecision(response.optionId) });
        await this.#lane.run(
            async () =>
                await this.#publish({
                    outcome: "selected",
                    requestId: response.requestId,
                    selectedOptionId: response.optionId,
                    sessionUpdate: "permission_resolved",
                }),
        );
    };

    readonly respondUserInput = async (response: SessionUserInputResponseV3, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (response.sessionId !== this.#sessionId) {
            throw new NativeSessionOperationErrorV3("stale_interaction", "The user-input request is no longer pending");
        }
        const pending = this.#pending.get(response.requestId);
        if (pending?.kind !== "user-input") {
            throw new NativeSessionOperationErrorV3("stale_interaction", "The user-input request is no longer pending");
        }
        const answers = Object.fromEntries(
            pending.questionIds.map((questionId) => {
                const value = response.values[questionId];
                const values = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
                return [questionId, { answers: values }];
            }),
        );
        this.#pending.delete(response.requestId);
        this.#appServer.respond(pending.nativeRequestId, { answers });
        await this.#lane.run(
            async () =>
                await this.#publish({
                    outcome: "submitted",
                    requestId: response.requestId,
                    sessionUpdate: "user_input_resolved",
                }),
        );
    };

    readonly waitForTermination = async (signal: AbortSignal): Promise<NativeSessionTerminationV3> => {
        signal.throwIfAborted();
        const cancelled = Promise.withResolvers<never>();
        const abort = (): void => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            return await Promise.race([this.#appServer.terminated, cancelled.promise]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };

    readonly close = async (signal: AbortSignal): Promise<void> => {
        if (this.#closed) {
            return;
        }
        signal.throwIfAborted();
        this.#closed = true;
        for (const pending of this.#pending.values()) {
            if (pending.kind === "permission") {
                this.#appServer.respond(pending.nativeRequestId, { decision: "cancel" });
            } else {
                this.#appServer.respond(pending.nativeRequestId, { answers: {} });
            }
        }
        this.#pending.clear();
        const turn = this.#turn;
        this.#turn = { kind: "idle" };
        if (turn.kind !== "idle") {
            turn.completion.reject(new NativeSessionOperationErrorV3("native_session_closed", "The Session closed"));
        }
        this.#appServer.detach();
        const child = this.#appServer.child();
        const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
        await stopProcessTree(child, captured);
    };
}

function settingsFromResume(resume: {
    readonly collaborationMode?: { readonly mode: "default" | "plan" } | null | undefined;
    readonly model?: string | null | undefined;
    readonly reasoningEffort?: string | null | undefined;
}): SessionSettingsV3 {
    return {
        settings: [
            ...(resume.model == null ? [] : [{ id: "model", name: "Model", value: resume.model }]),
            ...(resume.reasoningEffort == null
                ? []
                : [{ id: "reasoning_effort", name: "Reasoning effort", value: resume.reasoningEffort }]),
            ...(resume.collaborationMode == null
                ? []
                : [{ id: "collaboration_mode", name: "Mode", value: resume.collaborationMode.mode }]),
        ],
    };
}

export async function connectCodexNativeSessionV3(
    agent: NativeAgentLaunchV3,
    session: NativeSessionContextV3,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> {
    let connected: ConnectedCodexSessionV3 | null = null;
    const appServer = new CodexAppServerClient({
        command: agent.command,
        cwd: session.cwd,
        environment: agent.environment,
        handlers: {
            onNotification: async (method, params) => await connected?.onNotification(method, params),
            onServerRequest: async (request) => {
                if (connected === null) {
                    appServer.respondWithError(request.id, -32_000, "The native Session is not connected");
                    return;
                }
                await connected.onServerRequest(request);
            },
        },
    });
    try {
        await appServer.initialize(signal);
        const resume = threadResumeResponseSchema.parse(
            await appServer.request(
                "thread/resume",
                { cwd: session.cwd, excludeTurns: true, threadId: session.nativeSessionId },
                signal,
            ),
        );
        if (resume.thread.id !== session.nativeSessionId) {
            throw new NativeSessionOperationErrorV3(
                "session_identity_mismatch",
                "Codex opened a different native Session",
            );
        }
        connected = new ConnectedCodexSessionV3(appServer, session, live, settingsFromResume(resume));
        return connected;
    } catch (error) {
        appServer.detach();
        const child = appServer.child();
        const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
        await stopProcessTree(child, captured);
        throw error;
    }
}

export async function createCodexNativeSessionV3(
    agent: NativeAgentLaunchV3,
    session: Omit<NativeSessionContextV3, "nativeSessionId">,
    live: NativeSessionLiveRuntimeV3,
    signal: AbortSignal,
): Promise<ConnectedNativeSessionV3> {
    let connected: ConnectedCodexSessionV3 | null = null;
    const appServer = new CodexAppServerClient({
        command: agent.command,
        cwd: session.cwd,
        environment: agent.environment,
        handlers: {
            onNotification: async (method, params) => await connected?.onNotification(method, params),
            onServerRequest: async (request) => {
                if (connected === null) {
                    appServer.respondWithError(request.id, -32_000, "The native Session is not connected");
                    return;
                }
                await connected.onServerRequest(request);
            },
        },
    });
    try {
        await appServer.initialize(signal);
        const created = threadStartResponseSchema.parse(
            await appServer.request("thread/start", { cwd: session.cwd }, signal),
        );
        const context = { ...session, nativeSessionId: created.thread.id };
        connected = new ConnectedCodexSessionV3(appServer, context, live, settingsFromResume(created));
        return connected;
    } catch (error) {
        appServer.detach();
        const child = appServer.child();
        const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
        await stopProcessTree(child, captured);
        throw error;
    }
}
