import {
    encodeSessionRecordingWrite,
    encodeSessionRecordingWriteV3,
    isIdentifier,
    type SessionEventEnvelopeV2,
    type SessionEventV2,
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
    readonly #webhooks: AppSessionStatusWebhookStorage;
    readonly #webhookService: AppSessionStatusWebhookService;

    constructor(
        policies: RecordingPolicyStorage,
        provider: RecordingProvider,
        webhooks: AppSessionStatusWebhookStorage,
        webhookService: AppSessionStatusWebhookService,
    ) {
        if (provider.kind === "available" && !isIdentifier(provider.providerId)) {
            throw new Error("The Recording provider identifier is invalid");
        }
        this.#policies = policies;
        this.#provider = provider;
        this.#webhooks = webhooks;
        this.#webhookService = webhookService;
    }

    readonly deliver = async (
        target: SessionRecordingTarget,
        envelope: SessionEventEnvelopeV2,
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

    readonly deliverV3: SessionRecording["deliverV3"] = async (target, write, signal) => {
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
                new Request("https://recording.internal/v1/session-events-v3", {
                    body: encodeSessionRecordingWriteV3(write),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: AbortSignal.any([signal, AbortSignal.timeout(RECORDING_REQUEST_TIMEOUT_MILLISECONDS)]),
                }),
            );
            signal.throwIfAborted();
            await response.body?.cancel();
            return response.ok ? { kind: "recorded" } : { kind: "failed", code: "write_failed" };
        } catch {
            signal.throwIfAborted();
            return { kind: "failed", code: "write_failed" };
        }
    };

    async #publishTerminalStatus(
        target: SessionRecordingTarget,
        envelope: SessionEventEnvelopeV2,
        signal: AbortSignal,
    ): Promise<void> {
        const status = terminalStatus(envelope.events);
        const webhook = await this.#webhooks.read(target.projectId);
        if (status === null || webhook === null || !webhook.enabled || signal.aborted) {
            return;
        }
        const secret = await this.#webhookService.decryptSecret(webhook);
        const timestamp = Math.floor(Date.now() / 1_000).toString();
        const body = JSON.stringify({
            appId: webhook.appId,
            projectId: target.projectId,
            runtimeId: target.runtimeId,
            sessionId: target.sessionId,
            status,
        });
        try {
            const signature = `v1.${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
            const response = await fetch(webhook.endpoint, {
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
function terminalStatus(events: readonly SessionEventV2[]): "idle" | "failed" | null {
    let status: "idle" | "failed" | null = null;
    for (const event of events) {
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        switch (event.payload.kind) {
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
