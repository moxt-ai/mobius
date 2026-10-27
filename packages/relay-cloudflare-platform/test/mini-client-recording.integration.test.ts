import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay } from "@moxt-ai/mobius-relay-core";
import {
    decodeSessionRecordingDirectory,
    decodeSessionRecordingDirectoryV2,
    decodeSessionRecordingHistory,
    decodeSessionRecordingSummaryV2,
    encodeSessionEventEnvelope,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-sdk/protocol";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
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
        authorization: `Bearer ${clerk.session("developer-mini-recording", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    });
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
    expect(response.status).toBe(status);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
}

function text(value: Record<string, unknown>, key: string): string {
    const result = value[key];
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return result;
}

function turnMessage(sessionId: string): string {
    return encodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: `${sessionId}-requested`,
                position: "0",
                recordedAt: "2026-10-12T00:00:00.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "lifecycle-metadata",
                payload: {
                    kind: "prompt.requested",
                    commandId: "turn-1",
                    content: [{ type: "text", text: "Mini-client recording prompt" }],
                    context: { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] },
                },
            },
            {
                eventId: `${sessionId}-reply`,
                position: "1",
                recordedAt: "2026-10-12T00:00:01.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Durable mini-client reply" },
                },
            },
            {
                eventId: `${sessionId}-completed`,
                position: "2",
                recordedAt: "2026-10-12T00:00:02.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "lifecycle-metadata",
                payload: { kind: "prompt.completed", commandId: "turn-1", stopReason: "end_turn" },
            },
        ],
    });
}

async function recordThroughRelay(projectId: string, runtimeId: string, messages: readonly string[]): Promise<void> {
    await runInDurableObject(env.RUNTIME_RELAY.getByName(projectId), async (_instance, state) => {
        const pending: Promise<void>[] = [];
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, bindings(), { database });
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: context.storages,
                gateways: context.gateways,
                utilities: { waitUntil: (operation) => pending.push(operation) },
            }),
        );
        const response = await relay.fetch(
            new Request(`https://runtime.internal/projects/${projectId}/daemon`, {
                headers: {
                    Upgrade: "websocket",
                    "x-mobius-runtime-id": runtimeId,
                    "x-mobius-channel-id": runtimeId,
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
            // Delivered back to back, as a streaming Agent does, without waiting for any write.
            await Promise.all(messages.map((message) => relay.webSocketMessage(daemon, message)));
            await Promise.all(pending.splice(0));
        } finally {
            client.close(1000, "Mini-client Recording test complete");
            await Promise.allSettled(pending);
        }
    });
}

async function createRecordingProject(): Promise<{
    readonly credential: string;
    readonly environment: PlatformRelayBindings;
    readonly projectId: string;
    readonly worker: ReturnType<typeof createTestMobiusPlatformApp>;
}> {
    const worker = createTestMobiusPlatformApp(
        new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-mini-recording"])),
        createPlatformGateways,
    );
    const environment = bindings();
    const tenants = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/tenants`, {
                headers: developerHeaders(),
            }),
            environment,
        ),
        200,
    );
    const tenantValues = tenants["tenants"];
    if (!Array.isArray(tenantValues) || tenantValues.length === 0) {
        throw new Error("Expected a Platform tenant");
    }
    const app = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                body: JSON.stringify({
                    displayName: "Mini-client Recording App",
                    tenantId: text(tenantValues[0] as Record<string, unknown>, "tenantId"),
                }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const credentialValue = app["defaultCredential"];
    if (typeof credentialValue !== "object" || credentialValue === null) {
        throw new Error("Expected a default AppCredential");
    }
    const credential = text(credentialValue as Record<string, unknown>, "credential");
    const project = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                body: JSON.stringify({
                    displayName: "Mini-client Recording Project",
                    idempotencyKey: `mini-recording-${Date.now()}`,
                    locationHint: "wnam",
                }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const projectId = text(project, "projectId");
    await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/recording-policy`, {
                body: JSON.stringify({ mode: "enabled" }),
                headers: developerHeaders(),
                method: "PUT",
            }),
            environment,
        ),
        200,
    );
    return { credential, environment, projectId, worker };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
    clerk.reset();
});

describe.sequential("Mini-client Recording integration", () => {
    it("Given an enabled Project and recorded Turn, When a mini-client reads through MobiusClient, Then it sees durable history and the session directory", async () => {
        const { credential, environment, projectId, worker } = await createRecordingProject();

        const runtimeId = "runtime-mini-recording";
        const sessionId = "mini-client-recording-session";
        await recordThroughRelay(projectId, runtimeId, [turnMessage(sessionId)]);

        new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(credential),
            endpoint: relayOrigin,
            projectId,
            transport: {
                fetch: async (request) => await worker.request(request, undefined, environment, undefined),
            },
        });
        const history = await json(
            await worker.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        expect(decodeSessionRecordingHistory(JSON.stringify(history))).toMatchObject({
            sessionId,
            events: [
                { eventId: `${sessionId}-requested`, position: "0" },
                {
                    eventId: `${sessionId}-reply`,
                    payload: { content: { text: "Durable mini-client reply" } },
                    position: "1",
                },
                { eventId: `${sessionId}-completed`, position: "2" },
            ],
        });
        const directory = await json(
            await worker.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/recording/sessions?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        expect(decodeSessionRecordingDirectory(JSON.stringify(directory))).toMatchObject({
            sessions: [{ sessionId, status: "idle", title: "Mini-client recording prompt" }],
        });
        const summaryPath = `${relayOrigin}${MOBIUS_API_PREFIX}/v2/projects/${projectId}/recording/sessions`;
        const metadata = await json(
            await worker.request(
                `${summaryPath}?runtimeId=${runtimeId}&sessionId=${sessionId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        const summaries = decodeSessionRecordingDirectoryV2(JSON.stringify(metadata));
        expect(summaries.sessions).toEqual([
            expect.objectContaining({ sessionId, title: "Mini-client recording prompt" }),
        ]);
        expect(metadata).toEqual(summaries);
        const single = await json(
            await worker.request(
                `${summaryPath}/${sessionId}?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        expect(single).toEqual(decodeSessionRecordingSummaryV2(JSON.stringify(single)));
        expect(single).toEqual(summaries.sessions[0]);
        const denied = await worker.request(`${summaryPath}?runtimeId=${runtimeId}`, {}, environment);
        expect(denied.status).toBe(401);
    });

    it("Given an Agent streaming hundreds of reply chunks back to back, When history is read, Then every chunk is recorded in order", async () => {
        const { credential, environment, projectId, worker } = await createRecordingProject();
        const runtimeId = "runtime-streamed-recording";
        const sessionId = "streamed-recording-session";
        const chunkCount = 400;
        const messages = Array.from({ length: chunkCount }, (_, index) =>
            encodeSessionEventEnvelope({
                kind: "session.event.v2",
                events: [
                    {
                        eventId: `${sessionId}-chunk-${index}`,
                        position: String(index),
                        recordedAt: "2026-10-12T00:00:00.000Z",
                        sessionGenerationId: `${sessionId}-generation`,
                        sessionId,
                        type: "acp",
                        payload: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `chunk-${index};` },
                        },
                    },
                ],
            }),
        );
        await recordThroughRelay(projectId, runtimeId, messages);

        const history = await json(
            await worker.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        const recorded = decodeSessionRecordingHistory(JSON.stringify(history)).events.map((event) => event.eventId);
        expect(recorded).toEqual(Array.from({ length: chunkCount }, (_, index) => `${sessionId}-chunk-${index}`));
    });
});
