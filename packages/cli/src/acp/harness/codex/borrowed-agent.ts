import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { AcpExecutionError } from "../../acp-error.ts";
import { type AcpEndpointTermination, acpEndpointTerminationError } from "../../agent/in-process-endpoint.ts";
import type { CodexAppServerClient, CodexAppServerServerRequest } from "./app-server-client.ts";
import { CODEX_HISTORY_TURN_PAGE_LIMIT, threadTurnsPageSchema } from "./app-server-protocol.ts";
import { decodeThreadItem, reasoningText, toolCallUpdate } from "./items.ts";
import type { CodexSessionAgent } from "./session-agent.ts";
import type { CodexSessionUpdate } from "./session-update.ts";
import { promptResultWithMessageId } from "./session-update.ts";
import { userMessageUpdates } from "./user-message.ts";

const REQUEST_TIMEOUT = 30_000;
const POLL_INTERVAL = 500;
const queueResponseSchema = z.object({
    queuedSubmission: z.object({ id: z.string().min(1), clientUserMessageId: z.string().min(1) }),
});
const queuePageSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1), clientUserMessageId: z.string().min(1) })).max(100),
    nextCursor: z.string().nullish(),
});

interface PendingPrompt {
    readonly clientId: string;
    readonly completion: PromiseWithResolvers<PromptResponse>;
    input: { readonly kind: "awaiting" } | { readonly kind: "identified"; readonly messageId: string };
}

/** A locked thread remains owned by Codex. This connection only reads it and appends queued input. */
export class CodexBorrowedAcpAgent implements CodexSessionAgent {
    readonly steeringSupported = false;
    readonly #client: CodexAppServerClient;
    readonly #threadId: string;
    readonly #emit: (update: CodexSessionUpdate) => Promise<void>;
    readonly #closed = new AbortController();
    readonly #seen = new Map<string, string>();
    #pending: PendingPrompt | null = null;
    #watch: Promise<void> | null = null;
    #lifecycle:
        | { readonly kind: "following" }
        | { readonly kind: "failed"; readonly error: AcpExecutionError }
        | { readonly kind: "closed" } = { kind: "following" };

    constructor(client: CodexAppServerClient, threadId: string, emit: (update: CodexSessionUpdate) => Promise<void>) {
        this.#client = client;
        this.#threadId = threadId;
        this.#emit = emit;
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        // Probe the real queue port before advertising a usable compatibility connection.
        queuePageSchema.parse(
            await this.#client.request(
                "thread/queue/list",
                { threadId: this.#threadId },
                AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
            ),
        );
        await this.#refresh(signal, true);
        this.#watch = this.#follow();
    };

    readonly #follow = async (): Promise<void> => {
        const signal = this.#closed.signal;
        try {
            for (;;) {
                await setTimeout(POLL_INTERVAL, undefined, { signal });
                await this.#refresh(signal, false);
            }
        } catch (cause) {
            if (!signal.aborted) {
                const error = new AcpExecutionError(
                    "The owning Codex session could not be followed",
                    { cause },
                    "codex_queue_follow_failed",
                );
                this.#lifecycle = { kind: "failed", error };
                this.#pending?.completion.reject(error);
            }
        }
    };

    readonly #refresh = async (signal: AbortSignal, baseline: boolean): Promise<void> => {
        // Newest pages bound each idle scan. Follow additional pages while an old queued prompt is
        // outstanding so another client's turns cannot hide its result beyond the first page.
        let cursor: string | null = null;
        const pages: Array<z.infer<typeof threadTurnsPageSchema>["data"]> = [];
        const cursors = new Set<string>();
        do {
            const page = threadTurnsPageSchema.parse(
                await this.#client.request(
                    "thread/turns/list",
                    {
                        threadId: this.#threadId,
                        limit: CODEX_HISTORY_TURN_PAGE_LIMIT,
                        sortDirection: "desc",
                        itemsView: "full",
                        ...(cursor === null ? {} : { cursor }),
                    },
                    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
                ),
            );
            pages.push(page.data);
            cursor = page.nextCursor ?? null;
            if (cursor !== null && cursors.has(cursor)) {
                throw new AcpExecutionError("Codex repeated a history cursor", {}, "invalid_native_session_response");
            }
            if (cursor !== null) {
                cursors.add(cursor);
            }
        } while (cursor !== null && (baseline || this.#pending !== null));
        for (const turns of pages.reverse()) {
            for (const turn of [...turns].reverse()) {
                let matches = false;
                for (const raw of turn.items) {
                    const item = decodeThreadItem(raw);
                    if (item === null) {
                        continue;
                    }
                    const key = `${turn.id ?? ""}:${item.id}`;
                    if (item.type === "userMessage") {
                        const clientId: unknown =
                            typeof raw === "object" && raw !== null ? Reflect.get(raw, "clientId") : undefined;
                        matches ||= clientId === this.#pending?.clientId;
                        if (this.#pending !== null && clientId === this.#pending.clientId) {
                            this.#pending.input = { kind: "identified", messageId: item.id };
                        }
                        // Native user items, including this client's queued input, own their identities.
                        const text = item.content
                            .flatMap((block) =>
                                typeof block === "object" &&
                                block !== null &&
                                Reflect.get(block, "type") === "text" &&
                                typeof Reflect.get(block, "text") === "string"
                                    ? [String(Reflect.get(block, "text"))]
                                    : [],
                            )
                            .join("");
                        if (!baseline && !this.#seen.has(key)) {
                            for (const update of userMessageUpdates(item)) {
                                await this.#emit(update);
                            }
                        }
                        this.#seen.set(key, text);
                        continue;
                    }
                    const previous = this.#seen.get(key);
                    const value =
                        item.type === "agentMessage" ? item.text : (reasoningText(item) ?? JSON.stringify(item));
                    this.#seen.set(key, value);
                    if (baseline || value === previous) {
                        continue;
                    }
                    if (item.type === "agentMessage" || reasoningText(item) !== null) {
                        const text =
                            previous !== undefined && value.startsWith(previous) ? value.slice(previous.length) : value;
                        if (text.length > 0) {
                            await this.#emit({
                                sessionUpdate:
                                    item.type === "agentMessage" ? "agent_message_chunk" : "agent_thought_chunk",
                                messageId: item.id,
                                content: { type: "text", text },
                            });
                        }
                    } else {
                        const update = toolCallUpdate(item, "snapshot");
                        if (update !== null) {
                            if (previous === undefined) {
                                await this.#emit({ ...update, sessionUpdate: "tool_call" });
                            } else {
                                await this.#emit({ ...update, sessionUpdate: "tool_call_update" });
                            }
                        }
                    }
                }
                if (matches && turn.status !== undefined && turn.status !== "inProgress") {
                    if (turn.status === "failed") {
                        this.#pending?.completion.reject(
                            new AcpExecutionError("The owning Codex turn failed", {}, "codex_turn_failed"),
                        );
                    } else {
                        this.#pending?.completion.resolve({
                            stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn",
                        });
                    }
                }
            }
        }
    };

    readonly prompt = async (input: readonly unknown[], signal: AbortSignal): Promise<PromptResponse> => {
        signal.throwIfAborted();
        if (this.#lifecycle.kind === "failed") {
            throw this.#lifecycle.error;
        }
        if (this.#lifecycle.kind === "closed") {
            throw new AcpExecutionError("The Codex queue connection is closed", {}, "acp_endpoint_closed");
        }
        if (this.#pending !== null) {
            throw new AcpExecutionError("Another prompt is already running", {}, "session_busy");
        }
        const pending: PendingPrompt = {
            clientId: randomUUID(),
            completion: Promise.withResolvers<PromptResponse>(),
            input: { kind: "awaiting" },
        };
        this.#pending = pending;
        void pending.completion.promise.catch(() => {});
        const abort = (): void => pending.completion.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        let outcome: "completed" | "cancelled" = "cancelled";
        try {
            const queued = queueResponseSchema.parse(
                await this.#client.request(
                    "thread/queue/add",
                    {
                        threadId: this.#threadId,
                        input,
                        clientUserMessageId: pending.clientId,
                    },
                    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
                ),
            );
            if (queued.queuedSubmission.clientUserMessageId !== pending.clientId) {
                throw new AcpExecutionError(
                    "Codex queued an unexpected message",
                    {},
                    "invalid_native_session_response",
                );
            }
            const result = await pending.completion.promise;
            outcome = result.stopReason === "cancelled" ? "cancelled" : "completed";
            return pending.input.kind === "identified"
                ? await promptResultWithMessageId(Promise.resolve(result), pending.input.messageId)
                : result;
        } catch (cause) {
            if (pending.input.kind === "identified" && !signal.aborted) {
                return await promptResultWithMessageId(Promise.reject(cause), pending.input.messageId);
            }
            throw cause;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pending = null;
            if (outcome === "cancelled") {
                // Delete only this client's unconsumed submission. A claimed submission is already
                // absent; neither turn/interrupt nor queue/start is safe against the local owner.
                try {
                    await this.#removeQueuedInput(pending.clientId);
                } catch (cause) {
                    console.error("The cancelled Codex queued input could not be removed", cause);
                }
            }
        }
    };

    readonly #removeQueuedInput = async (clientId: string): Promise<void> => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
            const page = queuePageSchema.parse(
                await this.#client.request(
                    "thread/queue/list",
                    { threadId: this.#threadId, limit: 100, ...(cursor === null ? {} : { cursor }) },
                    signal,
                ),
            );
            for (const queued of page.data) {
                if (queued.clientUserMessageId === clientId) {
                    await this.#client.request(
                        "thread/queue/delete",
                        { threadId: this.#threadId, queuedSubmissionId: queued.id },
                        signal,
                    );
                    return;
                }
            }
            cursor = page.nextCursor ?? null;
            if (cursor !== null && cursors.has(cursor)) {
                throw new AcpExecutionError("Codex repeated a queue cursor", {}, "invalid_native_session_response");
            }
            if (cursor !== null) {
                cursors.add(cursor);
            }
        } while (cursor !== null);
    };

    readonly nativeTurnId = (): null => null;
    readonly steer = async (_params: unknown, signal: AbortSignal): Promise<never> => {
        signal.throwIfAborted();
        throw new AcpExecutionError("This Codex session only supports queued input", {}, "steering_unsupported");
    };
    // The reader connection cannot receive or control the owner's live turn.
    readonly onNotification = async (_method: string, _params: unknown): Promise<void> => {};
    readonly onServerRequest = async (request: CodexAppServerServerRequest): Promise<void> => {
        this.#client.respondWithError(request.id, -32_601, "Borrowed sessions cannot handle owner requests");
    };
    readonly onTerminated = (termination: AcpEndpointTermination): void => {
        const error = acpEndpointTerminationError(termination);
        this.#lifecycle = { kind: "failed", error };
        this.#pending?.completion.reject(error);
        this.#closed.abort();
    };

    // A remote Stop must never interrupt another client's owning turn.
    readonly compact = async (_signal: AbortSignal): Promise<PromptResponse> => {
        // Borrowed queue access cannot start a compaction on the owning session.
        throw new AcpExecutionError(
            "This Codex session is attached read-only and cannot be compacted",
            {},
            "native_session_unsupported",
        );
    };

    readonly cancel = async (): Promise<void> => {
        this.#pending?.completion.resolve({ stopReason: "cancelled" });
    };

    readonly close = async (): Promise<void> => {
        this.#lifecycle = { kind: "closed" };
        this.#closed.abort();
        await this.cancel();
        await this.#watch;
    };
}
