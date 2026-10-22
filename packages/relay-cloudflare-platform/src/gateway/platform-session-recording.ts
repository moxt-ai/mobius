import {
    RuntimeMessageScheduler,
    type SessionRecording,
    type SessionRecordingBatchResult,
    type SessionRecordingScope,
    type SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import {
    encodeSessionRecordingWrite,
    encodeSessionStatusWebhookBody,
    isIdentifier,
    type SessionEvent,
    type SessionEventEnvelope,
    type SessionStatusWebhookCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import type { AppSessionStatusWebhookService } from "../service/app-session-status-webhook-service.ts";
import type { AppSessionStatusWebhookStorage } from "../storage/app-session-status-webhook-storage.ts";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

const batchResponseSchema = v.object({
    results: v.pipe(
        v.array(
            v.variant("kind", [
                v.object({
                    sessionId: v.pipe(
                        v.string(),
                        v.check((value: string) => isIdentifier(value)),
                    ),
                    kind: v.literal("recorded"),
                }),
                v.object({
                    sessionId: v.pipe(
                        v.string(),
                        v.check((value: string) => isIdentifier(value)),
                    ),
                    kind: v.literal("failed"),
                    code: v.literal("write_failed"),
                }),
            ]),
        ),
        v.minLength(1),
        v.maxLength(256),
    ),
});

const RECORDING_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS = 2_000;

interface TerminalStatusNotification {
    readonly commands: readonly SessionStatusWebhookCommand[];
    readonly status: "running" | "idle" | "failed";
}

export type RecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

export class PlatformSessionRecording implements SessionRecording {
    readonly #policies: RecordingPolicyStorage;
    readonly #provider: RecordingProvider;
    readonly #transport: typeof fetch;
    readonly #webhooks: AppSessionStatusWebhookStorage;
    readonly #webhookService: AppSessionStatusWebhookService;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #webhookMessages = new RuntimeMessageScheduler(4, 512);

    constructor(
        policies: RecordingPolicyStorage,
        provider: RecordingProvider,
        webhooks: AppSessionStatusWebhookStorage,
        webhookService: AppSessionStatusWebhookService,
        waitUntil: (operation: Promise<void>) => void,
        transport: typeof fetch = globalThis.fetch.bind(globalThis),
    ) {
        if (provider.kind === "available" && !isIdentifier(provider.providerId)) {
            throw new Error("The Recording provider identifier is invalid");
        }
        this.#policies = policies;
        this.#provider = provider;
        this.#transport = transport;
        this.#webhooks = webhooks;
        this.#webhookService = webhookService;
        this.#waitUntil = waitUntil;
    }

    readonly deliverBatch = async (
        target: SessionRecordingScope,
        envelope: SessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<readonly SessionRecordingBatchResult[]> => {
        const sessions = [...new Set(envelope.events.map((event) => event.sessionId))];
        const failed = (
            code: "policy_unavailable" | "provider_unavailable" | "write_failed",
        ): readonly SessionRecordingBatchResult[] => sessions.map((sessionId) => ({ sessionId, kind: "failed", code }));
        console.info(JSON.stringify({ event: "recording_policy_read" }));
        const policy = await this.#policies.readProject(target.projectId, signal);
        if (policy === null) {
            return failed("policy_unavailable");
        }
        if (policy.effectiveMode === "disabled") {
            return sessions.map((sessionId) => ({ sessionId, kind: "skipped" }));
        }
        if (this.#provider.kind === "absent") {
            return failed("provider_unavailable");
        }
        // RuntimeRelay delivers Recording batches; an uncancellable AbortSignal.timeout would keep it awake
        // for the whole deadline after each write, so the timer is cleared once the write settles.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The Recording write timed out", "TimeoutError")),
            RECORDING_REQUEST_TIMEOUT_MILLISECONDS,
        );
        try {
            const response = await this.#provider.fetcher.fetch(
                new Request("https://recording.internal/v1/session-event-batches", {
                    body: encodeSessionRecordingWrite({
                        envelope,
                        projectId: target.projectId,
                        runtimeId: target.runtimeId,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: AbortSignal.any([signal, timeout.signal]),
                }),
            );
            signal.throwIfAborted();
            let results: readonly SessionRecordingBatchResult[];
            if (response.status === 404) {
                // An older Recording Worker has not appended anything at the missing batch route.
                // This compatibility path is safe during rolling deployment; uncertain writes are never retried.
                await response.body?.cancel();
                results = await this.#deliverLegacy(target, envelope, signal);
            } else {
                if (!response.ok) {
                    await response.body?.cancel();
                    return failed("write_failed");
                }
                results = v.parse(batchResponseSchema, await response.json()).results;
            }
            const decoded = { results };
            const identifiers = new Set(decoded.results.map((result) => result.sessionId));
            if (
                identifiers.size !== sessions.length ||
                decoded.results.length !== sessions.length ||
                sessions.some((id) => !identifiers.has(id))
            ) {
                return failed("write_failed");
            }
            const eventsBySession = new Map<string, SessionEventEnvelope["events"][number][]>();
            for (const event of envelope.events) {
                const events = eventsBySession.get(event.sessionId) ?? [];
                events.push(event);
                eventsBySession.set(event.sessionId, events);
            }
            for (const result of decoded.results) {
                const events = eventsBySession.get(result.sessionId) ?? [];
                const commands = terminatedCommands(events);
                if (result.kind !== "recorded" || commands.length === 0) {
                    continue;
                }
                const notification: TerminalStatusNotification = { commands, status: terminalStatus(events) ?? "idle" };
                // A slow webhook must not hold every Session in an already committed Recording batch.
                const publication = this.#webhookMessages
                    .run(
                        JSON.stringify([target.projectId, target.runtimeId, result.sessionId]),
                        signal,
                        async () =>
                            await this.#publishTerminalStatus(
                                { ...target, sessionId: result.sessionId },
                                notification,
                                signal,
                            ),
                    )
                    .catch(() => {
                        console.warn("Session status webhook failed", {
                            code: "session_status_webhook_failed",
                            sessionId: result.sessionId,
                        });
                    });
                this.#waitUntil(publication);
            }
            return decoded.results;
        } catch {
            signal.throwIfAborted();
            return failed("write_failed");
        } finally {
            clearTimeout(timer);
        }
    };

    async #deliverLegacy(
        target: SessionRecordingScope,
        envelope: SessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<readonly SessionRecordingBatchResult[]> {
        if (this.#provider.kind !== "available") {
            throw new Error("The Recording provider is unavailable");
        }
        const provider = this.#provider.fetcher;
        const grouped = new Map<string, SessionEventEnvelope["events"][number][]>();
        for (const event of envelope.events) {
            const events = grouped.get(event.sessionId) ?? [];
            events.push(event);
            grouped.set(event.sessionId, events);
        }
        const entries = [...grouped];
        const results = new Map<string, SessionRecordingBatchResult>();
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(4, entries.length) }, async () => {
                for (;;) {
                    const item = entries[next++];
                    if (item === undefined) {
                        return;
                    }
                    const [sessionId, events] = item;
                    let recorded = false;
                    try {
                        const response = await provider.fetch(
                            new Request("https://recording.internal/v1/session-events", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: encodeSessionRecordingWrite({
                                    ...target,
                                    envelope: { kind: envelope.kind, events },
                                }),
                                signal,
                            }),
                        );
                        recorded = response.ok;
                        await response.body?.cancel();
                    } catch {
                        signal.throwIfAborted();
                    }
                    results.set(
                        sessionId,
                        recorded
                            ? { sessionId, kind: "recorded" }
                            : { sessionId, kind: "failed", code: "write_failed" },
                    );
                }
            }),
        );
        return entries.map(
            ([sessionId]) => results.get(sessionId) ?? { sessionId, kind: "failed", code: "write_failed" },
        );
    }

    async #publishTerminalStatus(
        target: SessionRecordingTarget,
        notification: TerminalStatusNotification,
        signal: AbortSignal,
    ): Promise<void> {
        const webhook = await this.#webhooks.read(target.projectId);
        if (webhook === null || !webhook.enabled || signal.aborted) {
            return;
        }
        const secret = await this.#webhookService.decryptSecret(webhook);
        const timestamp = Math.floor(Date.now() / 1_000).toString();
        const body = encodeSessionStatusWebhookBody({
            appId: webhook.appId,
            commands: notification.commands,
            projectId: target.projectId,
            runtimeId: target.runtimeId,
            sessionId: target.sessionId,
            status: notification.status,
        });
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The Session status webhook timed out", "TimeoutError")),
            SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS,
        );
        try {
            const signature = `v1.${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
            const response = await this.#transport(webhook.endpoint, {
                body,
                headers: {
                    "content-type": "application/json",
                    "x-mobius-signature": signature,
                    "x-mobius-timestamp": timestamp,
                },
                method: "POST",
                signal: AbortSignal.any([signal, timeout.signal]),
            });
            await response.body?.cancel();
            if (!response.ok) {
                console.warn("Mobius Session status webhook rejected", { status: response.status });
            }
        } catch {
            if (!signal.aborted) {
                console.warn("Mobius Session status webhook failed");
            }
        } finally {
            clearTimeout(timer);
        }
    }
}
function terminalStatus(events: readonly SessionEvent[]): "running" | "idle" | "failed" | null {
    let status: "running" | "idle" | "failed" | null = null;
    for (const event of events) {
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        switch (event.payload.kind) {
            case "prompt.requested":
            case "prompt.started":
                status = "running";
                break;
            case "prompt.completed":
                status = "idle";
                break;
            case "prompt.failed":
            case "prompt.failed-before-start":
                status = "failed";
                break;
        }
    }
    return status;
}

/**
 * The commands this delivery watched finish, newest terminal outcome per command. The delivery only
 * observes the events it carries, so a command that ended earlier is absent here and must not be
 * inferred from these results.
 */
function terminatedCommands(events: readonly SessionEvent[]): SessionStatusWebhookCommand[] {
    const byCommand = new Map<string, SessionStatusWebhookCommand>();
    for (const event of events) {
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        const payload = event.payload;
        if (payload.kind === "prompt.completed") {
            const cancelled = payload.stopReason === "cancelled" || payload.stopReason === "canceled";
            byCommand.set(
                payload.commandId,
                cancelled
                    ? { cancelledAt: event.recordedAt, commandId: payload.commandId, outcome: "cancelled" }
                    : {
                          commandId: payload.commandId,
                          completedAt: event.recordedAt,
                          outcome: "succeeded",
                          stopReason: payload.stopReason,
                      },
            );
        } else if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
            byCommand.set(payload.commandId, {
                code: payload.code,
                commandId: payload.commandId,
                failedAt: event.recordedAt,
                message: payload.message,
                outcome: "failed",
            });
        }
    }
    return [...byCommand.values()];
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function platformRecordingProvider(environment: {
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
}): RecordingProvider {
    return environment.RECORDING === undefined || environment.RECORDING_PROVIDER_ID === undefined
        ? { kind: "absent" }
        : {
              fetcher: environment.RECORDING,
              kind: "available",
              providerId: environment.RECORDING_PROVIDER_ID,
          };
}
