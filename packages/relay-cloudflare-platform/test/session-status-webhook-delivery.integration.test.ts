import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay, type SessionRecording } from "@moxt-ai/mobius-relay-core";
import {
    decodeSessionStatusWebhookBody,
    encodeSessionEventEnvelope,
    MOBIUS_API_PREFIX,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
import { PlatformSessionStatusNotifications } from "../src/gateway/platform-session-status-notifications.ts";
import { AppSessionStatusWebhookService } from "../src/service/app-session-status-webhook-service.ts";
import { AppSessionStatusWebhookStorage } from "../src/storage/app-session-status-webhook-storage.ts";
import {
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

const relayOrigin = "https://platform.test";
const clerk = new FakeClerk();

function bindings(): PlatformRelayBindings {
    if (env.RECORDING === undefined || typeof env.RECORDING_PROVIDER_ID !== "string") {
        throw new Error("Expected the Recording provider binding");
    }
    return {
        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: env.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RECORDING: env.RECORDING,
        RECORDING_PROVIDER_ID: env.RECORDING_PROVIDER_ID,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
    };
}

function developerHeaders(): Headers {
    return new Headers({
        authorization: `Bearer ${clerk.session("developer-1", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    });
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
        throw new Error("Expected an object");
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
    const field = record(value)[key];
    if (typeof field !== "string") {
        throw new Error(`Expected ${key} to be a string`);
    }
    return field;
}

async function responseJson(response: Response, expectedStatus: number): Promise<Record<string, unknown>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    return record(body);
}

/** Records the notification a consumer would receive, answering it as accepted. */
class RecordedWebhookTransport {
    readonly #delivered: string[] = [];

    readonly fetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        this.#delivered.push(await request.text());
        return new Response("", { status: 202 });
    };

    get delivered(): readonly string[] {
        return this.#delivered;
    }

    /** The single notification a consumer received. */
    only(): string {
        const [delivered] = this.#delivered;
        if (delivered === undefined) {
            throw new Error("Expected a Session status notification");
        }
        return delivered;
    }
}

async function provisionProject(name: string): Promise<{ appId: string; projectId: string }> {
    const worker = createTestMobiusPlatformApp(
        new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
        createPlatformGateways,
    );
    const environment = bindings();
    const tenants = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/tenants`, {
                headers: developerHeaders(),
            }),
            environment,
        ),
        200,
    );
    const tenantValues = record(tenants)["tenants"];
    if (!Array.isArray(tenantValues) || tenantValues.length === 0) {
        throw new Error("Expected a Platform tenant");
    }
    const app = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                body: JSON.stringify({
                    displayName: `${name} App`,
                    tenantId: text(tenantValues[0], "tenantId"),
                }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const appId = text(app, "appId");
    const project = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                body: JSON.stringify({
                    displayName: `${name} Project`,
                    idempotencyKey: `${name}-${appId}`,
                    locationHint: "apac",
                }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/session-status-webhook`, {
                body: JSON.stringify({ enabled: true, endpoint: "https://consumer.example.test/webhook" }),
                headers: developerHeaders(),
                method: "PUT",
            }),
            environment,
        ),
        200,
    );
    return { appId, projectId: text(project, "projectId") };
}

function event(index: number, payload: Record<string, unknown>): SessionEventEnvelope["events"][number] {
    return {
        eventId: `session-status-delivery-event-${index}`,
        position: String(index),
        recordedAt: "2026-10-15T00:00:00.000Z",
        sessionGenerationId: "session-status-delivery-generation",
        sessionId: "session-status-delivery-session",
        type: "lifecycle-metadata",
        payload,
    } as SessionEventEnvelope["events"][number];
}

class StalledRecording implements SessionRecording {
    readonly started = Promise.withResolvers<void>();
    readonly release = Promise.withResolvers<void>();

    readonly deliverBatch: SessionRecording["deliverBatch"] = async (_target, envelope, signal) => {
        signal.throwIfAborted();
        this.started.resolve();
        const cancelled = Promise.withResolvers<never>();
        const cancel = () => cancelled.reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        try {
            await Promise.race([this.release.promise, cancelled.promise]);
            signal.throwIfAborted();
            return [...new Set(envelope.events.map((event) => event.sessionId))].map((sessionId) => ({
                sessionId,
                kind: "failed",
                code: "write_failed",
            }));
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    };
}

async function throughRelay(
    projectId: string,
    exercise: (
        send: (events: SessionEventEnvelope["events"]) => Promise<void>,
        flushNotifications: () => Promise<void>,
        transport: RecordedWebhookTransport,
    ) => Promise<void>,
    recording?: SessionRecording,
): Promise<RecordedWebhookTransport> {
    await registerRuntimeFixture(projectId, projectId);
    const environment = bindings();
    const webhookStorage = new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE);
    const transport = new RecordedWebhookTransport();
    const publications: Promise<void>[] = [];
    const notifications = new PlatformSessionStatusNotifications(
        webhookStorage,
        new AppSessionStatusWebhookService(
            null,
            webhookStorage,
            environment.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        ),
        (operation) => publications.push(operation),
        transport.fetch,
    );
    const flushNotifications = async () => {
        await Promise.all(publications.splice(0));
    };
    await runInDurableObject(environment.RUNTIME_RELAY.getByName(projectId), async (_instance, state) => {
        const pending: Promise<void>[] = [];
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, environment, { database });
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: context.storages,
                gateways: {
                    ...context.gateways,
                    notifications,
                    ...(recording === undefined ? {} : { recording }),
                },
                utilities: { waitUntil: (operation) => pending.push(operation) },
            }),
        );
        const response = await relay.fetch(
            new Request(`https://runtime.internal/projects/${projectId}/daemon`, {
                headers: {
                    Upgrade: "websocket",
                    "x-mobius-runtime-id": projectId,
                    "x-mobius-channel-id": projectId,
                },
            }),
        );
        expect(response.status).toBe(101);
        const client = response.webSocket;
        const daemon = state.getWebSockets("daemon")[0];
        if (client === null || daemon === undefined) {
            throw new Error("Expected a connected daemon");
        }
        client.accept();
        try {
            await exercise(
                async (events) =>
                    await relay.webSocketMessage(
                        daemon,
                        encodeSessionEventEnvelope({ events, kind: "session.event.v2" }),
                    ),
                flushNotifications,
                transport,
            );
            await flushNotifications();
        } finally {
            while (pending.length > 0) {
                await Promise.allSettled(pending.splice(0));
            }
            await flushNotifications();
            client.close(1000, "Test complete");
        }
    });
    return transport;
}

async function deliver(projectId: string, events: SessionEventEnvelope["events"]): Promise<RecordedWebhookTransport> {
    return await throughRelay(projectId, async (send) => await send(events));
}

describe("App Session status webhook delivery", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    afterAll(async () => {
        await abortAllDurableObjects();
    });

    it("Given a configured webhook, When saving its settings races rotating its secret, Then the stored webhook keeps both the rotated secret and the saved endpoint", async () => {
        const { appId } = await provisionProject("settings-rotation-race");
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
        );
        const environment = bindings();
        const webhookUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/session-status-webhook`;
        const service = new AppSessionStatusWebhookService(
            null,
            new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE),
            environment.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        );
        for (const round of [1, 2, 3, 4, 5]) {
            const endpoint = `https://consumer.example.test/webhook-${round}`;
            const [saved, rotated] = await Promise.all([
                worker.fetch(
                    new Request(webhookUrl, {
                        body: JSON.stringify({ enabled: true, endpoint }),
                        headers: developerHeaders(),
                        method: "PUT",
                    }),
                    environment,
                ),
                worker.fetch(
                    new Request(`${webhookUrl}/rotate`, { body: "{}", headers: developerHeaders(), method: "POST" }),
                    environment,
                ),
            ]);
            await responseJson(saved, 200);
            const secret = text(await responseJson(rotated, 200), "secret");
            const stored = await new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE).read(
                appId,
            );
            if (stored === null) {
                throw new Error("Expected the stored webhook");
            }
            expect(stored.endpoint).toBe(endpoint);
            expect(await service.decryptSecret(stored)).toBe(secret);
        }
    });

    it("Given Recording is disabled by default, When a command finishes, Then the enabled webhook receives its outcome", async () => {
        const { projectId } = await provisionProject("recording-disabled");
        const transport = await deliver(projectId, [
            event(1, { commandId: "finished-command", kind: "prompt.completed", stopReason: "stop" }),
        ]);

        expect(transport.delivered).toHaveLength(1);
        expect(decodeSessionStatusWebhookBody(transport.only()).commands).toStrictEqual([
            {
                commandId: "finished-command",
                completedAt: "2026-10-15T00:00:00.000Z",
                outcome: "succeeded",
                stopReason: "stop",
            },
        ]);
    });

    it("Given Recording stalls at capacity and then fails, When commands finish, Then their notifications are delivered independently", async () => {
        const { projectId } = await provisionProject("recording-unavailable");
        const recording = new StalledRecording();
        await throughRelay(
            projectId,
            async (send, flushNotifications, transport) => {
                const chunk = (index: number): SessionEventEnvelope["events"][number] => ({
                    eventId: `session-status-delivery-event-${index}`,
                    position: String(index),
                    recordedAt: "2026-10-15T00:00:00.000Z",
                    sessionGenerationId: "session-status-delivery-generation",
                    sessionId: "session-status-delivery-session",
                    type: "acp",
                    payload: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "x".repeat(900_000) },
                    },
                });
                try {
                    // Keep Recording's 32 MiB buffer occupied without waiting for its write.
                    await send(Array.from({ length: 7 }, (_, index) => chunk(index)));
                    await recording.started.promise;
                    for (let batch = 1; batch < 5; batch += 1) {
                        await send(Array.from({ length: 7 }, (_, index) => chunk(batch * 7 + index)));
                    }
                    await send([
                        chunk(35),
                        chunk(36),
                        chunk(37),
                        event(38, { commandId: "capacity-command", kind: "prompt.completed", stopReason: "stop" }),
                    ]);
                    await flushNotifications();
                    expect(transport.delivered.map((body) => decodeSessionStatusWebhookBody(body).commands)).toEqual([
                        [expect.objectContaining({ commandId: "capacity-command", outcome: "succeeded" })],
                    ]);

                    recording.release.resolve();
                    await send([
                        event(39, {
                            commandId: "failed-recording-command",
                            kind: "prompt.completed",
                            stopReason: "stop",
                        }),
                    ]);
                    await flushNotifications();
                    expect(
                        transport.delivered.flatMap((body) => decodeSessionStatusWebhookBody(body).commands),
                    ).toEqual([
                        expect.objectContaining({ commandId: "capacity-command", outcome: "succeeded" }),
                        expect.objectContaining({ commandId: "failed-recording-command", outcome: "succeeded" }),
                    ]);
                } finally {
                    recording.release.resolve();
                }
            },
            recording,
        );
    });

    it("Given a steer finished while the root prompt is still working, When the delivery is published, Then it resolves only the finished command and keeps the Session running", async () => {
        const { projectId } = await provisionProject("steer-root");
        const transport = await deliver(projectId, [
            event(1, {
                commandId: "steer-command",
                kind: "prompt.requested",
                content: [{ type: "text", text: "steer" }],
                targetCommandId: "root-command",
            }),
            event(2, {
                attemptId: "steer-attempt",
                commandId: "steer-command",
                epoch: "epoch-1",
                kind: "prompt.started",
            }),
            event(3, { commandId: "steer-command", kind: "prompt.completed", stopReason: "stop" }),
            event(4, {
                attemptId: "root-attempt",
                commandId: "root-command",
                epoch: "epoch-1",
                kind: "prompt.started",
            }),
        ]);

        const body = decodeSessionStatusWebhookBody(transport.only());
        expect(body.status).toBe("running");
        expect(body.commands).toStrictEqual([
            {
                commandId: "steer-command",
                completedAt: "2026-10-15T00:00:00.000Z",
                outcome: "succeeded",
                stopReason: "stop",
            },
        ]);
    });

    it("Given a batch that ends two commands in different ways, When the delivery is published, Then each command carries its own outcome", async () => {
        const { projectId } = await provisionProject("two-outcomes");
        const transport = await deliver(projectId, [
            event(1, { commandId: "finished-command", kind: "prompt.completed", stopReason: "stop" }),
            event(2, {
                code: "agent_error",
                commandId: "broken-command",
                kind: "prompt.failed-before-start",
                message: "the Agent could not start",
            }),
        ]);

        const body = decodeSessionStatusWebhookBody(transport.only());
        expect(body.status).toBe("failed");
        expect(body.commands).toStrictEqual([
            {
                commandId: "finished-command",
                completedAt: "2026-10-15T00:00:00.000Z",
                outcome: "succeeded",
                stopReason: "stop",
            },
            {
                code: "agent_error",
                commandId: "broken-command",
                failedAt: "2026-10-15T00:00:00.000Z",
                message: "the Agent could not start",
                outcome: "failed",
            },
        ]);
    });

    it("Given a batch with no finished command, When the delivery is published, Then no notification is sent", async () => {
        const { projectId } = await provisionProject("no-outcome");
        const transport = await deliver(projectId, [
            event(1, {
                attemptId: "root-attempt",
                commandId: "root-command",
                epoch: "epoch-1",
                kind: "prompt.started",
            }),
        ]);

        expect(transport.delivered).toStrictEqual([]);
    });
});
