import { RuntimeMessageScheduler, type SessionStatusNotifications } from "@moxt-ai/mobius-relay-core";
import {
    encodeSessionStatusWebhookBody,
    lastRecordedLifecycleStatus,
    type SessionLiveEvent,
    type SessionStatusWebhookCommand,
    sessionLiveEventSchema,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AppSessionStatusWebhookService } from "../service/app-session-status-webhook-service.ts";
import type { AppSessionStatusWebhookStorage } from "../storage/app-session-status-webhook-storage.ts";

const SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS = 2_000;

interface SessionStatusNotificationTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

interface TerminalStatusNotification {
    readonly commands: readonly SessionStatusWebhookCommand[];
    readonly status: "running" | "idle" | "failed";
}

export class PlatformSessionStatusNotifications implements SessionStatusNotifications {
    readonly #transport: typeof fetch;
    readonly #webhooks: AppSessionStatusWebhookStorage;
    readonly #webhookService: AppSessionStatusWebhookService;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #messages = new RuntimeMessageScheduler(4, 512);

    constructor(
        webhooks: AppSessionStatusWebhookStorage,
        webhookService: AppSessionStatusWebhookService,
        waitUntil: (operation: Promise<void>) => void,
        transport: typeof fetch = globalThis.fetch.bind(globalThis),
    ) {
        this.#transport = transport;
        this.#webhooks = webhooks;
        this.#webhookService = webhookService;
        this.#waitUntil = waitUntil;
    }

    readonly publish: SessionStatusNotifications["publish"] = (scope, envelope) => {
        const eventsBySession = new Map<string, SessionLiveEvent[]>();
        for (const wireEvent of envelope.events) {
            if (wireEvent.type !== "lifecycle-metadata") {
                continue;
            }
            const parsed = sessionLiveEventSchema.safeParse(wireEvent);
            if (!parsed.success) {
                continue;
            }
            const event = parsed.data;
            const events = eventsBySession.get(event.sessionId) ?? [];
            events.push(event);
            eventsBySession.set(event.sessionId, events);
        }
        for (const [sessionId, events] of eventsBySession) {
            const commands = terminatedCommands(events);
            if (commands.length === 0) {
                continue;
            }
            const notification: TerminalStatusNotification = {
                commands,
                status: lastRecordedLifecycleStatus(events) ?? "idle",
            };
            // Notifications own their deadline and capacity independently of Recording.
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(new DOMException("Session status webhook timed out", "TimeoutError")),
                SESSION_STATUS_WEBHOOK_TIMEOUT_MILLISECONDS,
            );
            const publication = this.#messages
                .run(
                    JSON.stringify([scope.projectId, scope.runtimeId, sessionId]),
                    controller.signal,
                    async () =>
                        await this.#publishTerminalStatus({ ...scope, sessionId }, notification, controller.signal),
                )
                .catch(() => {
                    console.warn("Session status webhook failed", {
                        code: "session_status_webhook_failed",
                        sessionId,
                    });
                })
                .finally(() => clearTimeout(timer));
            this.#waitUntil(publication);
        }
    };

    async #publishTerminalStatus(
        target: SessionStatusNotificationTarget,
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
                signal,
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
/**
 * The commands this delivery watched finish, newest terminal outcome per command. The delivery only
 * observes the events it carries, so a command that ended earlier is absent here and must not be
 * inferred from these results.
 */
function terminatedCommands(events: readonly SessionLiveEvent[]): SessionStatusWebhookCommand[] {
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
