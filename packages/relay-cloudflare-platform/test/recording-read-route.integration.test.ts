import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingHistory,
    decodeSessionRecordingHistoryPage,
    encodeSessionEventEnvelopeV2,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import { DurableObjectSqlDatabase, RuntimeRelay } from "@moxt-ai/mobius-relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const providerId = env.RECORDING_PROVIDER_ID;
    if (env.RECORDING === undefined || typeof providerId !== "string") {
        throw new Error("Expected the Recording provider binding");
    }
    return {
        APP_CREDENTIAL_CACHE: env.APP_CREDENTIAL_CACHE,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RECORDING: env.RECORDING,
        RECORDING_PROVIDER_ID: providerId,
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

function credentialHeaders(credential: string): Headers {
    return new Headers({ authorization: `Bearer ${credential}` });
}

async function responseJson(response: Response, expectedStatus: number): Promise<Readonly<Record<string, unknown>>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    return record(body);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function text(value: Readonly<Record<string, unknown>>, name: string): string {
    const field = value[name];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return field;
}

async function recordThroughRelay(projectId: string, sessionId: string, textContent: string) {
    return await runInDurableObject(env.RUNTIME_RELAY.getByName(projectId), async (_instance, state) => {
        const pending: Promise<void>[] = [];
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, bindings(), { database });
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: context.storages,
                gateways: context.gateways,
                utilities: {
                    waitUntil: (operation) => {
                        pending.push(operation);
                    },
                },
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
            await relay.webSocketMessage(
                daemon,
                encodeSessionEventEnvelopeV2({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `event-${sessionId}`,
                            position: "1",
                            provenance: { kind: "original" },
                            recordedAt: "2026-09-18T00:00:00.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "acp",
                            payload: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "text", text: textContent },
                            },
                        },
                    ],
                }),
            );
            await Promise.all(pending.splice(0));
        } finally {
            client.close(1000, "Test complete");
            await Promise.allSettled(pending);
        }
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
    clerk.reset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Platform Recording read route", () => {
    // @no-uc: Technical regression; authenticated reads must traverse Platform routing into durable Recording.
    it("Given an enabled Project policy, When a Platform app reads through the production boundary, Then durable events are returned", async () => {
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
        const tenantValues = tenants["tenants"];
        if (!Array.isArray(tenantValues) || tenantValues.length === 0) {
            throw new Error("Expected a Platform tenant");
        }
        const app = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({
                        displayName: "Recording route App",
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
        const credential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Recording route Project",
                        idempotencyKey: `recording-route-${appId}`,
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const projectId = text(project, "projectId");
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

        const sessionId = "recording-route-session";
        const runtimeId = projectId;
        await recordThroughRelay(projectId, sessionId, "recording route answer");

        const readUrl =
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
            `/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}`;
        const recorded = await worker.fetch(
            new Request(readUrl, { headers: credentialHeaders(credential) }),
            environment,
        );

        expect(recorded.status).toBe(200);
        expect(decodeSessionRecordingHistory(await recorded.text())).toMatchObject({
            events: [{ payload: { content: { text: "recording route answer" } } }],
            sessionId,
        });
    });
    // @no-uc: Technical regression; incremental cursor reads must traverse Platform routing unchanged.
    it("Given an enabled Project policy, When a Platform app reads after a cursor, Then only later events arrive as a bounded page", async () => {
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
        const tenantValues = tenants["tenants"];
        if (!Array.isArray(tenantValues) || tenantValues.length === 0) {
            throw new Error("Expected a Platform tenant");
        }
        const app = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({
                        displayName: "Recording route App",
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
        const credential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Recording route Project",
                        idempotencyKey: `recording-route-${appId}`,
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const projectId = text(project, "projectId");
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

        const sessionId = "recording-route-session";
        const runtimeId = projectId;
        await recordThroughRelay(projectId, sessionId, "recording route answer");

        const readUrl =
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
            `/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}&after=1`;
        const page = await worker.fetch(new Request(readUrl, { headers: credentialHeaders(credential) }), environment);

        expect(page.status).toBe(200);
        expect(decodeSessionRecordingHistoryPage(await page.text())).toMatchObject({
            events: [],
            nextCursor: null,
            tailCursor: "1",
            sessionId,
            truncated: false,
            version: 2,
        });
    });
});
