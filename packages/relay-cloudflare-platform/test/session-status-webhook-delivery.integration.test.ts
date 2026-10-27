import { env } from "cloudflare:workers";
import {
    decodeSessionStatusWebhookBody,
    MOBIUS_API_PREFIX,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { PlatformSessionRecording, platformRecordingProvider } from "../src/gateway/platform-session-recording.ts";
import { AppSessionStatusWebhookService } from "../src/service/app-session-status-webhook-service.ts";
import { AppSessionStatusWebhookStorage } from "../src/storage/app-session-status-webhook-storage.ts";
import { RecordingPolicyStorage } from "../src/storage/recording-policy-storage.ts";
import {
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";

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
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/recording-policy`, {
                body: JSON.stringify({ mode: "enabled" }),
                headers: developerHeaders(),
                method: "PUT",
            }),
            environment,
        ),
        200,
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

async function deliver(projectId: string, events: SessionEventEnvelope["events"]): Promise<RecordedWebhookTransport> {
    const environment = bindings();
    const webhookStorage = new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE);
    const transport = new RecordedWebhookTransport();
    const notifications: Promise<void>[] = [];
    const recording = new PlatformSessionRecording(
        new RecordingPolicyStorage(environment.PLATFORM_DIRECTORY_DATABASE),
        platformRecordingProvider(environment),
        webhookStorage,
        new AppSessionStatusWebhookService(
            null,
            webhookStorage,
            environment.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        ),
        (operation) => notifications.push(operation),
        transport.fetch,
    );
    await recording.deliverBatch(
        { projectId, runtimeId: projectId },
        { events, kind: "session.event.v2" },
        new AbortController().signal,
    );
    await Promise.all(notifications);
    return transport;
}

describe("App Session status webhook delivery", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
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
