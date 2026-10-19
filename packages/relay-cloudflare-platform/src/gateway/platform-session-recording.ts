import {
    encodeSessionRecordingWrite,
    encodeSessionStatusWebhookBody,
    isIdentifier,
    type SessionEvent,
    type SessionEventEnvelope,
    type SessionStatusWebhookCommand,
} from "@moxt-ai/mobius-protocol";
import type {
    SessionRecording,
    SessionRecordingDeliveryResult,
    SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import type { AppSessionStatusWebhookService } from "../service/app-session-status-webhook-service.ts";
import type { AppSessionStatusWebhookStorage } from "../storage/app-session-status-webhook-storage.ts";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

const RECORDING_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS = 2_000;

export type RecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

export class PlatformSessionRecording implements SessionRecording {
    readonly #policies: RecordingPolicyStorage;
    readonly #provider: RecordingProvider;
    readonly #transport: typeof fetch;
    readonly #webhooks: AppSessionStatusWebhookStorage;
    readonly #webhookService: AppSessionStatusWebhookService;

    constructor(
        policies: RecordingPolicyStorage,
        provider: RecordingProvider,
        webhooks: AppSessionStatusWebhookStorage,
        webhookService: AppSessionStatusWebhookService,
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
    }

    readonly deliver = async (
        target: SessionRecordingTarget,
        envelope: SessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<SessionRecordingDeliveryResult> => {
        const policy = await this.#policies.readProject(target.projectId, signal);
        if (policy === null) {
            return { kind: "failed", code: "policy_unavailable" };
        }
        if (policy.effectiveMode === "disabled") {
            return { kind: "skipped" };
        }
        if (this.#provider.kind === "absent") {
            return { kind: "failed", code: "provider_unavailable" };
        }
        try {
            const response = await this.#provider.fetcher.fetch(
                new Request("https://recording.internal/v1/session-events", {
                    body: encodeSessionRecordingWrite({
                        envelope,
                        projectId: target.projectId,
                        runtimeId: target.runtimeId,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: AbortSignal.any([signal, AbortSignal.timeout(RECORDING_REQUEST_TIMEOUT_MILLISECONDS)]),
                }),
            );
            signal.throwIfAborted();
            await response.body?.cancel();
            if (!response.ok) {
                return { kind: "failed", code: "write_failed" };
            }
            await this.#publishTerminalStatus(target, envelope, signal);
            return { kind: "recorded" };
        } catch {
            signal.throwIfAborted();
            return { kind: "failed", code: "write_failed" };
        }
    };

    async #publishTerminalStatus(
        target: SessionRecordingTarget,
        envelope: SessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<void> {
        const commands = terminatedCommands(envelope.events);
        if (commands.length === 0) {
            return;
        }
        const webhook = await this.#webhooks.read(target.projectId);
        if (webhook === null || !webhook.enabled || signal.aborted) {
            return;
        }
        const status = terminalStatus(envelope.events) ?? "idle";
        const secret = await this.#webhookService.decryptSecret(webhook);
        const timestamp = Math.floor(Date.now() / 1_000).toString();
        const body = encodeSessionStatusWebhookBody({
            appId: webhook.appId,
            commands,
            projectId: target.projectId,
            runtimeId: target.runtimeId,
            sessionId: target.sessionId,
            status,
        });
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
                signal: AbortSignal.any([signal, AbortSignal.timeout(SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS)]),
            });
            await response.body?.cancel();
            if (!response.ok) {
                console.warn("Mobius Session status webhook rejected", { status: response.status });
            }
        } catch {
            if (!signal.aborted) {
                console.warn("Mobius Session status webhook failed");
            }
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
