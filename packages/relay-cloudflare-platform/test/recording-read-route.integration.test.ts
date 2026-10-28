import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay } from "@moxt-ai/mobius-relay-core";
import {
    decodeSessionRecordingHistory,
    decodeSessionRecordingHistoryPage,
    decodeSessionRecordingTurnPage,
    encodeSessionEventEnvelope,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-sdk/protocol";
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
import { registerRuntimeFixture } from "./registered-runtime.ts";

const relayOrigin = "https://platform.test";
const clerk = new FakeClerk();

function bindings(): PlatformRelayBindings {
    const providerId = env.RECORDING_PROVIDER_ID;
    if (env.RECORDING === undefined || typeof providerId !== "string") {
        throw new Error("Expected the Recording provider binding");
    }
    return {
        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: env.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
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

async function readWithin(read: Promise<Response>, milliseconds: number): Promise<Response | undefined> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            read,
            new Promise<undefined>((resolve) => {
                timeout = setTimeout(() => resolve(undefined), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function readAfterCancelledWaits(
    read: (signal: AbortSignal) => Promise<Response>,
    append: () => Promise<void>,
): Promise<ReturnType<typeof decodeSessionRecordingHistoryPage>> {
    // One overflow response establishes that all 64 durable waiter slots were occupied before cancellation.
    const controllers = Array.from({ length: 65 }, () => new AbortController());
    const readers = controllers.map((controller) => read(controller.signal));
    const completed = Promise.allSettled(readers);
    try {
        const overflow = await readWithin(Promise.race(readers), 2000);
        if (overflow === undefined) {
            throw new Error("Expected all 64 Recording waiters to fill before their 10-second timeout");
        }
        expect(overflow.status).toBe(200);
        expect(decodeSessionRecordingHistoryPage(await overflow.text()).events).toEqual([]);
    } finally {
        for (const controller of controllers) {
            controller.abort(new DOMException("The reader cancelled its live read", "AbortError"));
        }
        await completed;
    }
    // Allow cancellation to propagate through both service boundaries before declaring the pool leaked.
    for (let attempt = 0; attempt < 10; attempt++) {
        const controller = new AbortController();
        try {
            const next = read(controller.signal);
            const immediate = await readWithin(next, 100);
            if (immediate !== undefined) {
                expect(immediate.status).toBe(200);
                expect(decodeSessionRecordingHistoryPage(await immediate.text()).events).toEqual([]);
                continue;
            }
            await append();
            const response = await next;
            expect(response.status).toBe(200);
            return decodeSessionRecordingHistoryPage(await response.text());
        } finally {
            controller.abort();
        }
    }
    throw new Error("No waiter capacity was released after caller cancellation");
}

async function recordThroughRelay(projectId: string, sessionId: string, textContent: string) {
    await registerRuntimeFixture(projectId, projectId);
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
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `event-${sessionId}`,
                            position: "1",
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

async function recordSessionEvents(
    projectId: string,
    sessionId: string,
    generationId: string,
    events: readonly { readonly position: string; readonly text: string }[],
): Promise<void> {
    await registerRuntimeFixture(projectId, projectId);
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
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: events.map((event) => ({
                        eventId: `event-${generationId}-${event.position}`,
                        position: event.position,
                        recordedAt: "2026-09-18T00:00:00.000Z",
                        sessionGenerationId: generationId,
                        sessionId,
                        type: "acp",
                        payload: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: event.text },
                        },
                    })),
                }),
            );
            await Promise.all(pending.splice(0));
        } finally {
            client.close(1000, "Recording generation test complete");
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
        const execution = await worker.fetch(
            new Request(
                `${readUrl.replace("/events?", "/execution?")}&commandId=missing-first&commandId=missing-second`,
                { headers: credentialHeaders(credential) },
            ),
            environment,
        );
        expect(execution.status).toBe(200);
        expect(await execution.json()).toMatchObject({ version: 1, sessionId, commands: [], activeCommands: null });
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
            tailCursor: "v2:1:1",
            sessionId,
            truncated: false,
            generationReset: false,
            version: 2,
        });
        const waited = await worker.fetch(
            new Request(`${readUrl}&waitMs=1`, { headers: credentialHeaders(credential) }),
            environment,
        );
        expect(waited.status).toBe(200);
        expect(waited.headers.get("Mobius-Recording-Wait-Supported")).toBe("1");
        expect(decodeSessionRecordingHistoryPage(await waited.text())).toMatchObject({
            events: [],
            tailCursor: "v2:1:1",
        });
        expect(
            (
                await worker.fetch(
                    new Request(`${readUrl}&waitMs=10001`, { headers: credentialHeaders(credential) }),
                    environment,
                )
            ).status,
        ).toBe(400);
        const afterCancellation = await readAfterCancelledWaits(
            async (signal) =>
                await worker.fetch(
                    new Request(`${readUrl}&waitMs=10000`, { headers: credentialHeaders(credential), signal }),
                    environment,
                ),
            () =>
                recordSessionEvents(projectId, sessionId, "session-generation-1", [
                    { position: "2", text: "answer after cancelled reads" },
                ]),
        );
        expect(afterCancellation.events).toMatchObject([
            { position: "2", payload: { content: { text: "answer after cancelled reads" } } },
        ]);
    });

    it("Given an enabled Project policy, When a Platform app reads Turn history through the production boundary, Then Recording serves the projected page", async () => {
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

        const turnsUrl =
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
            `/recording/sessions/${sessionId}/turns?runtimeId=${runtimeId}&limit=10`;
        const turns = await worker.fetch(
            new Request(turnsUrl, { headers: credentialHeaders(credential) }),
            environment,
        );
        expect(turns.status).toBe(200);
        expect(decodeSessionRecordingTurnPage(await turns.text())).toMatchObject({
            nextCursor: null,
            sessionId,
            tailCursor: "v2:1:1",
            turns: [],
            version: 1,
        });

        const invalid = await worker.fetch(
            new Request(`${turnsUrl}&before=item:1`, { headers: credentialHeaders(credential) }),
            environment,
        );
        expect(invalid.status).toBe(400);
        const oversized = await worker.fetch(
            new Request(turnsUrl.replace("limit=10", "limit=101"), { headers: credentialHeaders(credential) }),
            environment,
        );
        expect(oversized.status).toBe(400);
        expect(await oversized.json()).toMatchObject({ error: { code: "invalid_request" } });
        const missing = await worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
                    `/recording/sessions/${sessionId}/turns/missing-command/items` +
                    `?runtimeId=${runtimeId}&before=before:item:2`,
                { headers: credentialHeaders(credential) },
            ),
            environment,
        );
        expect(missing.status).toBe(404);

        // A read continues one run, so it names one direction: a page's cursor fed to the other one
        // would overlap the run it came from and list work twice.
        const itemsUrl =
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
            `/recording/sessions/${sessionId}/turns/missing-command/items?runtimeId=${runtimeId}`;
        for (const query of [
            "",
            "&after=after:item:1&before=before:item:2",
            "&after=before:item:2",
            "&before=after:item:1",
        ]) {
            const wrongWay = await worker.fetch(
                new Request(`${itemsUrl}${query}`, { headers: credentialHeaders(credential) }),
                environment,
            );
            expect(wrongWay.status).toBe(400);
        }
    });

    it("Given a daemon reload and Session generation reset, When a Platform app continues from an append cursor, Then reloaded events are retained", async () => {
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
                        displayName: "Recording restart App",
                        tenantId: text(tenantValues[0], "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const credential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                    body: JSON.stringify({
                        displayName: "Recording restart Project",
                        idempotencyKey: `recording-restart-${text(app, "appId")}`,
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
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/recording-policy`,
                    {
                        body: JSON.stringify({ mode: "enabled" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    },
                ),
                environment,
            ),
            200,
        );

        const sessionId = "recording-restart-session";
        const beforeRestart = [
            { position: "1", text: "turn 1 before restart" },
            { position: "2", text: "turn 2 before restart" },
        ];
        const afterRestart = [
            { position: "1", text: "reloaded turn after restart" },
            { position: "2", text: "new turn after restart" },
        ];
        await recordSessionEvents(projectId, sessionId, "generation-before-restart", beforeRestart);

        const baseUrl =
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}` +
            `/recording/sessions/${sessionId}/events?runtimeId=${projectId}`;
        const firstPage = decodeSessionRecordingHistoryPage(
            await (
                await worker.request(
                    new Request(`${baseUrl}&after=0&limit=1`, { headers: credentialHeaders(credential) }),
                    undefined,
                    environment,
                )
            ).text(),
        );
        expect(firstPage).toMatchObject({
            events: [expect.objectContaining({ eventId: "event-generation-before-restart-1" })],
            nextCursor: "v2:1:1",
            truncated: true,
        });

        // A daemon restart closes the old socket and reload rebuilds the same Session under a new
        // generation. The second call below intentionally creates a new Runtime relay connection.
        await recordSessionEvents(projectId, sessionId, "generation-after-restart", afterRestart);
        const followUp = new URL(baseUrl);
        followUp.searchParams.set("after", firstPage.nextCursor ?? "");
        followUp.searchParams.set("limit", "10");
        const secondResponse = await worker.request(
            new Request(followUp, { headers: credentialHeaders(credential) }),
            undefined,
            environment,
        );
        expect(secondResponse.status, `follow-up ${followUp.href} returned ${secondResponse.status}`).toBe(200);
        const secondPage = decodeSessionRecordingHistoryPage(await secondResponse.text());
        expect(secondPage.events.map((event) => event.payload)).toEqual(
            [...beforeRestart.slice(1), ...afterRestart].map((event) => ({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.text },
            })),
        );
        expect(secondPage.generationReset).toBe(true);
        expect(secondPage.truncated).toBe(false);
    });
});

describe.sequential("App Session status webhook", () => {
    it("Given an App without webhook configuration, When a developer reads it, Then the empty settings are valid", async () => {
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
                        displayName: "Webhook App",
                        tenantId: text(tenantValues[0], "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );

        const webhook = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/session-status-webhook`,
                    { headers: developerHeaders() },
                ),
                environment,
            ),
            200,
        );

        expect(webhook).toStrictEqual({
            appId: text(app, "appId"),
            configured: false,
            enabled: false,
            endpoint: "",
            secretId: "",
        });

        const saved = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/session-status-webhook`,
                    {
                        body: JSON.stringify({ enabled: true, endpoint: "https://consumer.example.test/webhook" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    },
                ),
                environment,
            ),
            200,
        );

        expect(saved).toMatchObject({
            appId: text(app, "appId"),
            configured: true,
            enabled: true,
            endpoint: "https://consumer.example.test/webhook",
        });
        expect(typeof text(saved, "secret")).toBe("string");

        const reread = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/session-status-webhook`,
                    { headers: developerHeaders() },
                ),
                environment,
            ),
            200,
        );

        expect(reread).toStrictEqual({
            appId: text(app, "appId"),
            configured: true,
            enabled: true,
            endpoint: "https://consumer.example.test/webhook",
            secretId: text(saved, "secretId"),
        });
    });
});
