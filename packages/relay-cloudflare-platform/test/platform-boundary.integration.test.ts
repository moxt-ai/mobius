import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    RuntimeRelay,
    type SessionRecording,
} from "@moxt-ai/mobius-relay-core";
import {
    decodeContentChunkFrame,
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    decodeSessionAccessCredential,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
    decodeSessionRecordingHistory,
    encodeContentAvailableEvent,
    encodeContentChunkFrame,
    encodeContentReadyEvent,
    encodeFileBeginEvent,
    encodeNativeSessionRequest,
    encodeNativeSessionResult,
    encodeSessionClosedEvent,
    encodeSessionConfigReadResult,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    encodeSessionEventEnvelope,
    encodeSessionHistoryPageLoaded,
    encodeSessionInfoUpdatedEvent,
    encodeSessionOperationFailedEvent,
    encodeSessionPreviewHistoryPageLoaded,
    encodeSessionPromptCommand,
    encodeSessionRenamedEvent,
    encodeSessionStatusChangedEvent,
    type LifecycleMetadata,
    MOBIUS_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    type SessionConfigReadResult,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
import {
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";

class ControlledRecording implements SessionRecording {
    readonly started = Promise.withResolvers<void>();
    readonly release = Promise.withResolvers<void>();
    readonly contents: string[] = [];
    #first = true;

    readonly deliverBatch: SessionRecording["deliverBatch"] = async (_target, envelope, signal) => {
        const sessions = [...new Set(envelope.events.map((event) => event.sessionId))];
        signal.throwIfAborted();
        if (this.#first) {
            this.#first = false;
            this.started.resolve();
            const cancelled = Promise.withResolvers<never>();
            const cancel = () => cancelled.reject(signal.reason);
            signal.addEventListener("abort", cancel, { once: true });
            try {
                await Promise.race([this.release.promise, cancelled.promise]);
            } finally {
                signal.removeEventListener("abort", cancel);
            }
            signal.throwIfAborted();
            return sessions.map((sessionId) => ({ sessionId, kind: "failed", code: "write_failed" }));
        }
        this.contents.push(...envelope.events.map((event) => JSON.stringify(event)));
        return sessions.map((sessionId) => ({ sessionId, kind: "recorded" }));
    };
}

function liveEvent(sessionId: string, text: string): string {
    return encodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                sessionId,
                type: "acp",
                payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
            },
        ],
    });
}

const relayOrigin = "https://platform.test";
const clerk = new FakeClerk();
const readyAgents = [
    {
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 1.0.0",
        capabilities: {
            additionalDirectories: true,
            audioPrompt: false,
            closeSession: true,
            deleteSession: true,
            embeddedContextPrompt: true,
            imagePrompt: true,
            listSessions: true,
            loadSession: true,
            promptQueueing: false,
            renameSession: false,
            resumeSession: true,
            steering: false,
            unstableForkSession: false,
        },
        id: "codex",
        label: "Codex",
        sessionTurnConfiguration: true,
    },
];

function bindings(): PlatformRelayBindings {
    return {
        APP_CREDENTIAL_CACHE: env.APP_CREDENTIAL_CACHE,
        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: env.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
    };
}

/** The installed Recording provider scenarios use, matching the deployed Platform service binding. */
function recordingBindings(): PlatformRelayBindings {
    const providerId = env.RECORDING_PROVIDER_ID;
    if (env.RECORDING === undefined || typeof providerId !== "string") {
        throw new Error("Expected the Recording provider binding");
    }
    return { ...bindings(), RECORDING: env.RECORDING, RECORDING_PROVIDER_ID: providerId };
}

function developerHeaders(): Headers {
    return new Headers({
        authorization: `Bearer ${clerk.session("developer-1", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    });
}

function credentialHeaders(credential: string): Headers {
    return new Headers({ authorization: `Bearer ${credential}`, "content-type": "application/json" });
}

class UnavailableProjectNamespace implements DurableObjectNamespace {
    readonly #source: DurableObjectNamespace;
    #accessCount = 0;

    constructor(source: DurableObjectNamespace) {
        this.#source = source;
    }

    get accessCount(): number {
        return this.#accessCount;
    }

    readonly newUniqueId: DurableObjectNamespace["newUniqueId"] = (options) => this.#source.newUniqueId(options);

    readonly idFromName: DurableObjectNamespace["idFromName"] = (name) => this.#source.idFromName(name);

    readonly idFromString: DurableObjectNamespace["idFromString"] = (id) => this.#source.idFromString(id);

    readonly get: DurableObjectNamespace["get"] = (id, options) => this.#source.get(id, options);

    readonly getByName: DurableObjectNamespace["getByName"] = () => {
        this.#accessCount += 1;
        throw new Error("Project storage must not be accessed");
    };

    readonly jurisdiction: DurableObjectNamespace["jurisdiction"] = (jurisdiction) =>
        new UnavailableProjectNamespace(this.#source.jurisdiction(jurisdiction));
}

class SocketMessages {
    readonly #messages: unknown[] = [];
    readonly #resolvers: Array<(message: unknown) => void> = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly nextFrame = (): Promise<unknown> => {
        const message = this.#messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.#resolvers.push(resolve))
            : Promise.resolve(message);
    };

    readonly next = async (): Promise<string> => {
        const message = await this.nextFrame();
        if (typeof message !== "string") {
            throw new Error("Expected a text WebSocket message");
        }
        return message;
    };
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

async function responseJson(response: Response, expectedStatus: number): Promise<Readonly<Record<string, unknown>>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    return record(body);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
    clerk.reset();
});

afterEach(() => {
    vi.useRealTimers();
});

afterAll(async () => {
    await abortAllDurableObjects();
});

describe.sequential("Platform Session-only boundary", () => {
    it("Given no viewers are connected, When the daemon broadcasts and Recording first fails, Then later events are still recorded without redelivery", async () => {
        await runInDurableObject(env.RUNTIME_RELAY.getByName("unwatched-runtime"), async (_instance, state) => {
            const recording = new ControlledRecording();
            const pending: Promise<void>[] = [];
            const database = new DurableObjectSqlDatabase(state.storage);
            const context = createPlatformDurableObjectContext(state, bindings(), { database });
            const relay = new RuntimeRelay(
                createDurableObjectDependencies({
                    doDatabase: database,
                    storages: context.storages,
                    gateways: { ...context.gateways, recording },
                    utilities: {
                        waitUntil: (operation) => {
                            pending.push(operation);
                        },
                    },
                }),
            );
            const response = await relay.fetch(
                new Request("https://runtime.internal/projects/unwatched-project/daemon", {
                    headers: {
                        Upgrade: "websocket",
                        "x-mobius-runtime-id": "unwatched-runtime",
                        "x-mobius-channel-id": "unwatched-channel",
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
            const event = (text: string) => liveEvent("unwatched-session", text);
            try {
                await relay.webSocketMessage(daemon, event("first"));
                await recording.started.promise;
                await relay.webSocketMessage(daemon, event("second"));
                recording.release.resolve();
                await Promise.all(pending);
                expect(recording.contents.map((payload) => JSON.parse(payload).payload.content.text)).toEqual([
                    "second",
                ]);
            } finally {
                recording.release.resolve();
                await Promise.all(pending);
                client.close(1000, "Test complete");
            }
        });
    });

    it("Given an allowed Chat origin, When the browser preflights a Session file read, Then Platform permits the request", async () => {
        const browserOrigin = "https://chat.test";
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(
                clerk.authenticator,
                new Set(["developer-1"]),
                new Set([browserOrigin]),
            ),
            createPlatformGateways,
        );
        const projectId = "prj_ap_01_abcdefghijklmnopqrstuvwx";

        const response = await worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/local-session/files/content?maxBytes=33554432&path=%2Fworkspace%2Fpackage.json`,
                {
                    headers: {
                        "access-control-request-headers": "authorization",
                        "access-control-request-method": "GET",
                        origin: browserOrigin,
                    },
                    method: "OPTIONS",
                },
            ),
            bindings(),
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    });

    it("Given a Session route the Platform no longer serves, When an app requests pending interactions, Then the Platform answers with a typed JSON not_found error", async () => {
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
        );
        const projectId = "prj_ap_01_abcdefghijklmnopqrstuvwx";

        const response = await worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/local-session/interactions`,
                { headers: { authorization: "Bearer app_credential" } },
            ),
            bindings(),
        );

        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("Given a Platform developer, When it issues an AppCredential, Then Session permissions are accepted and retired Conversation permissions are rejected", async () => {
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
        const values = tenants["tenants"];
        if (!Array.isArray(values) || values.length === 0) {
            throw new Error("Expected a Platform tenant");
        }
        const tenantId = text(record(values[0]), "tenantId");
        const app = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({ displayName: "Session-only App", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const sessionCredential = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/credentials`, {
                    body: JSON.stringify({ permissions: ["session:write"], projectIds: [] }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        expect(sessionCredential["permissions"]).toEqual(["session:write"]);

        const retired = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/credentials`, {
                    body: JSON.stringify({ permissions: ["conversation:create"], projectIds: [] }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            400,
        );
        expect(retired).toMatchObject({ error: { code: "project_permission_invalid" } });
    });

    it("Given an all-Projects AppCredential and an unavailable Project, When the developer lists credentials, Then the credential is returned without accessing Project storage", async () => {
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
        const values = tenants["tenants"];
        if (!Array.isArray(values) || values.length === 0) {
            throw new Error("Expected a Platform tenant");
        }
        const tenantId = text(record(values[0]), "tenantId");
        const app = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({ displayName: "All Projects App", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const defaultCredentialId = text(record(app["defaultCredential"]), "credentialId");
        await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Unavailable Project",
                        idempotencyKey: "unavailable-project",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const unavailableProjects = new UnavailableProjectNamespace(environment.PROJECT_RELAY);

        const listed = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/credentials`, {
                    headers: developerHeaders(),
                }),
                { ...environment, PROJECT_RELAY: unavailableProjects },
            ),
            200,
        );

        expect(listed).toMatchObject({
            credentials: [{ allProjects: true, credentialId: defaultCredentialId, projectIds: [] }],
        });
        expect(unavailableProjects.accessCount).toBe(0);
    });

    it("Given a cached AppCredential and unavailable directory storage, When Chat authorizes a Session credential, Then authorization succeeds without waiting for last-used persistence", async () => {
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
                        displayName: "Cached Session authorization",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Cached Session authorization Project",
                        idempotencyKey: "cached-session-authorization-project",
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
        const sessionId = "cached-session";
        const runtimeId = "cached-runtime";
        const sessionAccess = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                    {
                        body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                        headers: credentialHeaders(appCredential),
                        method: "POST",
                    },
                ),
                environment,
            ),
            201,
        );

        const response = await runInDurableObject(
            environment.PROJECT_RELAY.getByName(projectId),
            async (_instance, state) =>
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/live-event-subscription-target`,
                        { headers: credentialHeaders(text(sessionAccess, "credential")) },
                    ),
                    {
                        ...environment,
                        MOBIUS_PROJECT_DATABASE: new DurableObjectDatabaseAdapter(state.storage),
                        MOBIUS_PROJECT_ID: projectId,
                        PLATFORM_DIRECTORY_DATABASE: env.TEST_UNINITIALIZED_SHARD,
                    },
                ),
        );

        expect(await responseJson(response, 200)).toMatchObject({ kind: "expiring", projectId, runtimeId });
    });

    it("Given Recording is not installed, When a developer configures App and Project policy, Then disabled inheritance works, enablement is rejected, and Session policy is unavailable", async () => {
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
                        displayName: "Recording policy App",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
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
                        displayName: "Recording policy Project",
                        idempotencyKey: "recording-policy-project",
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
        const appPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/recording-policy`;
        expect(
            await responseJson(
                await worker.fetch(new Request(appPolicyUrl, { headers: developerHeaders() }), environment),
                200,
            ),
        ).toEqual({
            effectiveMode: "disabled",
            inheritedFrom: "system",
            mode: "inherit",
            providerAvailable: false,
        });
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(appPolicyUrl, {
                        body: JSON.stringify({ mode: "enabled" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    }),
                    environment,
                ),
                409,
            ),
        ).toMatchObject({ error: { code: "recording_provider_unavailable" } });
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(appPolicyUrl, {
                        body: JSON.stringify({ mode: "disabled" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    }),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ effectiveMode: "disabled", inheritedFrom: "app", mode: "disabled" });

        const projectPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/projects/${projectId}/recording-policy`;
        expect(
            await responseJson(
                await worker.fetch(new Request(projectPolicyUrl, { headers: developerHeaders() }), environment),
                200,
            ),
        ).toMatchObject({ effectiveMode: "disabled", inheritedFrom: "app", mode: "inherit" });
        await responseJson(
            await worker.fetch(
                new Request(projectPolicyUrl, {
                    body: JSON.stringify({ mode: "disabled" }),
                    headers: developerHeaders(),
                    method: "PUT",
                }),
                environment,
            ),
            200,
        );
        const sessionPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/projects/${projectId}/sessions/session-policy/recording-policy`;
        const sessionPolicyResponse = await worker.fetch(
            new Request(sessionPolicyUrl, {
                body: JSON.stringify({ mode: "disabled" }),
                headers: developerHeaders(),
                method: "PUT",
            }),
            environment,
        );
        expect(sessionPolicyResponse.status).toBe(404);
    });

    // Graceful eviction drains in-flight Runtime events before hibernating the sockets.
    it("Given a linked Codex Runtime with required empty installation metadata, When Chat imports, forks, configures and prompts Sessions across Relay hibernation, Then results, answers and connection status arrive without cloud Session storage", async () => {
        vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
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
        const tenantId = text(record(tenantValues[0]), "tenantId");
        const app = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({ displayName: "Private reconnect", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Private reconnect Project",
                        idempotencyKey: "private-reconnect-project",
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
        const pairing = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "private-reconnect-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const redemptionUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`;
        const claimed = await responseJson(
            await worker.fetch(
                new Request(redemptionUrl, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        machineName: "Private reconnect Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "private-reconnect-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        expect(claimed["appId"]).toBe(appId);
        const runtimeId = text(claimed, "runtimeId");
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/agents`,
                        { headers: credentialHeaders(appCredential) },
                    ),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ agents: [{ id: "codex", label: "Codex" }], runtimeId });
        const sessionId = "local-codex-session";
        const daemonResponse = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
            }),
            environment,
        );
        const hostResponse = await worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/host?token=${appCredential}&nativeRequestId=viewer-must-stay-live`,
                {
                    headers: { Upgrade: "websocket" },
                },
            ),
            environment,
        );
        expect(daemonResponse.status).toBe(101);
        expect(hostResponse.status).toBe(101);
        if (daemonResponse.webSocket === null || hostResponse.webSocket === null) {
            throw new Error("Expected both channel sockets");
        }
        const daemon = daemonResponse.webSocket;
        const host = hostResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        const hostMessages = new SocketMessages(host);
        daemon.accept();
        host.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            const rollback = {
                kind: "runtime.upgrade.result",
                requestId: "local-npm-upgrade",
                version: "0.0.227",
                targetVersion: "0.0.228",
                outcome: {
                    status: "failed",
                    code: "worker_exited",
                    message: "The new daemon exited before becoming ready",
                    retryAfter: 3600000,
                },
            };
            daemon.send(JSON.stringify(rollback));
            expect(JSON.parse(await hostMessages.next())).toEqual(rollback);
            const closeResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/session-to-close/close`,
                    {
                        body: "{}",
                        headers: credentialHeaders(appCredential),
                        method: "POST",
                    },
                ),
                environment,
            );
            const closeCommand = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(closeCommand).toMatchObject({
                kind: "session.close",
                sessionId: "session-to-close",
            });
            if (closeCommand.kind !== "session.close") {
                throw new Error("Expected a Session close command");
            }
            expect(decodeServiceToDaemonMessage(await hostMessages.next())).toMatchObject(closeCommand);
            daemon.send(
                encodeSessionClosedEvent({
                    kind: "session.closed",
                    requestId: closeCommand.requestId,
                    sessionId: "session-to-close",
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                kind: "session.closed",
                requestId: closeCommand.requestId,
                sessionId: "session-to-close",
            });
            expect(await responseJson(await closeResponse, 200)).toEqual({
                kind: "session.closed",
                requestId: closeCommand.requestId,
                sessionId: "session-to-close",
            });
            // Native HTTP probes use request-reply connections, while this viewer keeps its live subscription.
            for (const outcome of ["idle", "busy"] as const) {
                const activeTurnResponse = worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/active-turn`,
                        {
                            body: JSON.stringify({ additionalDirectoryIds: [], agentId: "codex", directoryId: "root" }),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                );
                const query = decodeServiceToDaemonMessage(await daemonMessages.next());
                if (query.kind !== "native.session.request" || query.action !== "active-turn") {
                    throw new Error("Expected the HTTP active Turn query to reach the daemon");
                }
                expect(decodeServiceToDaemonMessage(await hostMessages.next())).toMatchObject(query);
                const reply =
                    outcome === "idle"
                        ? encodeNativeSessionResult({
                              kind: "native.session.result",
                              action: "active-turn",
                              requestId: query.requestId,
                              sessionId,
                              targetSessionId: sessionId,
                              turn: null,
                              queued: [],
                          })
                        : encodeSessionOperationFailedEvent({
                              kind: "session.operation.failed",
                              requestId: query.requestId,
                              sessionId,
                              code: "native_session_busy",
                              message: "Another native session operation is running",
                          });
                daemon.send(reply);
                expect(JSON.parse(await hostMessages.next())).toMatchObject({ requestId: query.requestId });
                expect(await responseJson(await activeTurnResponse, outcome === "idle" ? 200 : 503)).toMatchObject(
                    outcome === "idle"
                        ? { action: "active-turn", turn: null, queued: [] }
                        : { error: { code: "native_session_busy" } },
                );
            }
            // A Host can multiplex discovery, but routing must remain bounded and reject overload explicitly.
            const discoveryRequests = Array.from({ length: 4 }, (_, index) => ({
                kind: "agent.settings.discover",
                agentId: "a".repeat(128),
                requestId: `settings-${index}`.padEnd(128, "r"),
            }));
            const hostClosed = Promise.withResolvers<{ readonly kind: "host.closed"; readonly code: number }>();
            host.addEventListener("close", (event) => hostClosed.resolve({ kind: "host.closed", code: event.code }), {
                once: true,
            });
            for (const request of discoveryRequests) {
                host.send(JSON.stringify(request));
                expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject(request);
            }
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    agentId: "a".repeat(128),
                    requestId: "settings-overflow",
                }),
            );
            host.send(JSON.stringify({ kind: "runtime.ping", requestId: "settings-capacity-barrier" }));
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "runtime.ping",
                requestId: "settings-capacity-barrier",
            });
            expect(
                await Promise.race([hostMessages.next().then((message) => JSON.parse(message)), hostClosed.promise]),
            ).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-overflow",
                code: "agent_settings_discovery_busy",
            });
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("runtime.ping");
            for (const request of discoveryRequests) {
                daemon.send(
                    JSON.stringify({
                        kind: "agent.settings.discovery.failed",
                        requestId: request.requestId,
                        code: "probe_failed",
                        message: "Controlled discovery failure",
                    }),
                );
                expect(JSON.parse(await hostMessages.next())).toMatchObject({
                    kind: "agent.settings.discovery.failed",
                    requestId: request.requestId,
                });
            }
            // Native imports and forks share this Runtime transport with configuration and live output.
            const closed = Promise.withResolvers<{ readonly kind: "closed"; readonly code: number }>();
            daemon.addEventListener("close", (event) => closed.resolve({ kind: "closed", code: event.code }), {
                once: true,
            });
            for (const action of ["import", "fork"] as const) {
                const requestId = `native-${action}-request`;
                const directoryId = action === "fork" ? `root-${"d".repeat(2000)}` : "root";
                const targetSessionId = `native-${action}-session`;
                host.send(
                    encodeNativeSessionRequest({
                        action,
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: "workspace",
                        directoryId,
                        entryId: "native-entry",
                        kind: "native.session.request",
                        requestId,
                        sessionId: "discovery-session",
                        targetSessionId,
                    }),
                );
                expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("native.session.request");
                expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("native.session.request");
            }
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    agentId: "codex",
                    requestId: "settings-before-wake",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-wake",
            });
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    agentId: "codex",
                    requestId: "settings-before-wake",
                }),
            );
            host.send(JSON.stringify({ kind: "runtime.ping", requestId: "settings-duplicate-barrier" }));
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "runtime.ping",
                requestId: "settings-duplicate-barrier",
            });
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("runtime.ping");
            await evictDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), { webSockets: "hibernate" });
            for (const action of ["import", "fork"] as const) {
                const requestId = `native-${action}-request`;
                const directoryId = action === "fork" ? `root-${"d".repeat(2000)}` : "root";
                const targetSessionId = `native-${action}-session`;
                const capabilities = readyAgents[0]?.capabilities;
                if (capabilities === undefined) {
                    throw new Error("Expected the connected Agent capabilities");
                }
                const result = encodeNativeSessionResult({
                    action,
                    kind: "native.session.result",
                    requestId,
                    sessionId: "discovery-session",
                    targetSessionId: targetSessionId,
                    title: "Imported native session",
                    ready: {
                        additionalDirectories: [],
                        agentId: "codex",
                        agentName: "Codex",
                        agentVersion: "1.0.0",
                        capabilities,
                        commands: [],
                        configOptions: [],
                        directoryId: directoryId,
                        directoryLabel: "Workspace",
                        kind: "session.ready",
                        requestId,
                        restored: true,
                        sessionId: action === "import" ? "original-native-session" : targetSessionId,
                    },
                });
                daemon.send(result);
                const received = await Promise.race([
                    hostMessages.next().then((message) => decodeDaemonToServiceMessage(message)),
                    closed.promise,
                ]);
                expect(received).toMatchObject({ kind: "native.session.result", action, requestId, targetSessionId });
                expect(daemon.readyState).toBe(WebSocket.OPEN);
                // The caller owns operation expiry and duplicate handling.
                vi.setSystemTime(new Date("2030-01-01T00:06:00.000Z"));
                daemon.send(result);
                expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                    kind: "native.session.result",
                    action,
                    requestId,
                    targetSessionId,
                });
                expect(daemon.readyState).toBe(WebSocket.OPEN);
            }
            vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));

            vi.setSystemTime(new Date("2030-01-01T00:03:00.000Z"));
            daemon.send(
                JSON.stringify({
                    kind: "agent.settings.discovery.failed",
                    requestId: "settings-before-wake",
                    code: "probe_failed",
                    message: "Controlled discovery failure",
                }),
            );
            // The next frame is a barrier if discovery routing silently discarded the result.
            daemon.send(liveEvent(sessionId, "settings response barrier"));
            expect(JSON.parse(await hostMessages.next())).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-before-wake",
                code: "probe_failed",
            });
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "session.event.v2" });
            vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
            // A newer Runtime may publish an event this Relay does not understand yet. The event is
            // observational, so skipping it must not disconnect the Runtime or block supported work.
            daemon.send(JSON.stringify({ kind: "session.future.changed", sessionId, value: "future" }));
            host.send(JSON.stringify({ kind: "session.future.request", sessionId, value: "future" }));
            host.send(
                encodeSessionConfigureCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    booleanValue: false,
                    configId: "model",
                    directoryId: "root",
                    kind: "session.configure",
                    requestId: "local-config-request",
                    sessionId,
                    value: "model-deepseek-v4.1-flash",
                    valueType: "select",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.configure");
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("session.configure");
            daemon.send(
                encodeSessionConfigUpdatedEvent({
                    configOptions: [],
                    kind: "session.config.updated",
                    requestId: "local-config-request",
                    sessionId,
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                configOptions: [],
                kind: "session.config.updated",
                requestId: "local-config-request",
                sessionId,
            });
            host.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId: "local-codex-command",
                    directoryId: "root",
                    disposition: "reject",
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "show the local answer",
                    sessionId,
                    targetCommandId: "",
                }),
            );
            const prompt = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(prompt.kind).toBe("session.prompt");
            if (prompt.kind !== "session.prompt") {
                throw new Error("Expected the prompt to reach the local Runtime");
            }
            expect(decodeSessionPromptCommand(JSON.stringify(prompt)).prompt).toBe("show the local answer");
            const answer = liveEvent(sessionId, "local answer");
            daemon.send(answer);
            const received = decodeSessionEventEnvelope(await hostMessages.next());
            expect(JSON.stringify(received.events.map((event) => event.payload))).toContain("local answer");
            expect(received).not.toHaveProperty("cursor");
            expect(received).not.toHaveProperty("sequence");
            // Relay broadcasts the original V2 identity unchanged, including duplicate frames.
            daemon.send(answer);
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("local answer");

            // Given Recording stalls then fails, subsequent live events still reach the viewer.
            await runInDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), async (_instance, state) => {
                const recording = new ControlledRecording();
                const pending: Promise<void>[] = [];
                const database = new DurableObjectSqlDatabase(state.storage);
                const context = createPlatformDurableObjectContext(state, environment, { database });
                const relay = new RuntimeRelay(
                    createDurableObjectDependencies({
                        doDatabase: database,
                        storages: context.storages,
                        gateways: { ...context.gateways, recording },
                        utilities: {
                            waitUntil: (operation) => {
                                pending.push(operation);
                            },
                        },
                    }),
                );
                const daemonSocket = state.getWebSockets("daemon")[0];
                if (daemonSocket === undefined) {
                    throw new Error("Expected a connected daemon");
                }
                const frame = (text: string) => liveEvent(sessionId, text);
                try {
                    await relay.webSocketMessage(daemonSocket, frame("recording is stalled"));
                    await recording.started.promise;
                    await relay.webSocketMessage(daemonSocket, frame("live output continues"));
                    recording.release.resolve();
                    await Promise.all(pending);
                    expect(recording.contents.map((payload) => JSON.parse(payload).payload.content.text)).toEqual([
                        "live output continues",
                    ]);
                } finally {
                    recording.release.resolve();
                    await Promise.all(pending);
                }
            });
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("recording is stalled");
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("live output continues");
            const browserAccess = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                        {
                            body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                201,
            );
            const v2Response = await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/events-v2`,
                    {
                        headers: {
                            authorization: `Bearer ${text(browserAccess, "credential")}`,
                            Upgrade: "websocket",
                        },
                    },
                ),
                environment,
            );
            expect(v2Response.status).toBe(101);
            if (v2Response.webSocket === null) {
                throw new Error("Expected the V2 Session event socket");
            }
            const v2Socket = v2Response.webSocket;
            const v2Messages = new SocketMessages(v2Socket);
            v2Socket.accept();
            const rawEvent = {
                eventId: "event-v2-1",
                payload: {
                    content: { text: "raw local answer", type: "text" as const },
                    messageId: "message-v2-1",
                    sessionUpdate: "agent_message_chunk" as const,
                },
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                sessionId,
                type: "acp" as const,
            };
            const historicalEvent = {
                eventId: rawEvent.eventId,
                payload: rawEvent.payload,
                recordedAt: rawEvent.recordedAt,
                sessionGenerationId: rawEvent.sessionGenerationId,
                sessionId: rawEvent.sessionId,
                type: rawEvent.type,
            };
            const secondRawEvent = { ...rawEvent, eventId: "event-v2-2", position: "2" };
            daemon.send(encodeSessionEventEnvelope({ events: [rawEvent, secondRawEvent], kind: "session.event.v2" }));
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "session.event.v2" });
            expect(JSON.parse(await v2Messages.next())).toEqual([rawEvent, secondRawEvent]);
            const historyResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/events-v2?limit=50&omit=agent-reasoning`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const historyLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (historyLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected history loading without a preceding Session query");
            }
            expect(historyLoad.omit).toBeUndefined();

            daemon.send(
                encodeSessionStatusChangedEvent({
                    kind: "session.status.changed",
                    sessionId,
                    status: { commandId: "command-1", kind: "working" },
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                kind: "session.status.changed",
                sessionId,
                status: { commandId: "command-1", kind: "working" },
            });
            daemon.send(
                encodeSessionInfoUpdatedEvent({
                    kind: "session.info.updated",
                    sessionId,
                    title: "Renamed session",
                    updatedAt: "2026-09-18T00:01:00.000Z",
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                kind: "session.info.updated",
                projectId,
                sessionId,
                title: "Renamed session",
                updatedAt: "2026-09-18T00:01:00.000Z",
            });
            const historyPage = encodeSessionHistoryPageLoaded({
                events: {
                    events: {
                        sessionGenerationId: "session-generation-1",
                        events: [rawEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
                kind: "session.live-history.v2.page.loaded",
                requestId: historyLoad.requestId,
                sessionId,
            });
            daemon.send(historyPage);
            expect(await responseJson(await historyResponse, 200)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [historicalEvent],
                nextCursor: null,
                tailCursor: rawEvent.eventId,
                truncated: false,
                version: 2,
            });
            // Direct Runtime HTTP owns the response until it completes; hibernate between requests.
            await evictDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), { webSockets: "hibernate" });
            // A delayed result after the caller has finished must not disconnect the Runtime.
            daemon.send(historyPage);
            const previewHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/native-events-preview?agentId=codex&directoryId=root&eventLimit=50&omit=agent-reasoning`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const previewHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (previewHistoryLoad.kind !== "session.preview-history.page.load") {
                throw new Error("Expected a native Session preview history request");
            }
            expect(previewHistoryLoad.omit).toBeUndefined();

            const previewHistoryPage = encodeSessionPreviewHistoryPageLoaded({
                events: {
                    events: {
                        sessionGenerationId: "native-session-generation-1",
                        events: [rawEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
                kind: "session.preview-history.page.loaded",
                requestId: previewHistoryLoad.requestId,
                sessionId,
            });
            daemon.send(previewHistoryPage);
            expect(await responseJson(await previewHistoryResponse, 200)).toEqual({
                events: {
                    sessionGenerationId: "native-session-generation-1",
                    events: [historicalEvent],
                    nextCursor: null,
                    tailCursor: rawEvent.eventId,
                    truncated: false,
                    version: 2,
                },
                queuedPromptRequests: [],
            });
            await evictDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), { webSockets: "hibernate" });
            // A delayed result after the caller has finished must not disconnect the Runtime.
            daemon.send(previewHistoryPage);
            const failedPreviewHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/native-events-preview?agentId=codex&directoryId=root&eventLimit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const failedPreviewHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (failedPreviewHistoryLoad.kind !== "session.preview-history.page.load") {
                throw new Error("Expected a native Session preview history request");
            }
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "native_history_unavailable",
                    kind: "session.operation.failed",
                    message: "The Codex thread is not loaded",
                    requestId: failedPreviewHistoryLoad.requestId,
                    sessionId,
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                code: "native_history_unavailable",
                kind: "session.operation.failed",
                message: "The Codex thread is not loaded",
                requestId: failedPreviewHistoryLoad.requestId,
            });
            expect(await responseJson(await failedPreviewHistoryResponse, 503)).toEqual({
                error: {
                    code: "native_history_unavailable",
                    message: "The Codex thread is not loaded",
                },
            });
            // A Runtime that closed the Session refuses to load its history. The refusal is a typed conflict, so a
            // client can offer to reopen the Session instead of retrying the load.
            const closedHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/events-v2?limit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const closedHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (closedHistoryLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a live Session history request");
            }
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "session_closed",
                    kind: "session.operation.failed",
                    message: "The Session is closed",
                    requestId: closedHistoryLoad.requestId,
                    sessionId,
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                code: "session_closed",
                kind: "session.operation.failed",
                requestId: closedHistoryLoad.requestId,
            });
            expect(await responseJson(await closedHistoryResponse, 409)).toEqual({
                error: { code: "session_closed", message: "The Session is closed" },
            });
            v2Socket.close(1000, "V2 browser test complete");
            const transportResponse = await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/transport`, { headers: { Upgrade: "websocket" } }),
                environment,
            );
            expect(transportResponse.status).toBe(101);
            if (transportResponse.webSocket === null) {
                throw new Error("Expected the browser transport socket");
            }
            const transport = transportResponse.webSocket;
            const transportMessages = new SocketMessages(transport);
            transport.accept();
            transport.send(
                JSON.stringify({
                    headers: [["authorization", `Bearer ${text(browserAccess, "credential")}`]],
                    kind: "session.events.subscribe",
                    path: `${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/events-v2`,
                    subscriptionId: "subscription-1",
                }),
            );
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                kind: "session.events.ready",
                subscriptionId: "subscription-1",
            });
            daemon.send(answer);
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("local answer");
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                data: expect.stringContaining("local answer"),
                eventId: "",
                kind: "session.events.event",
                seqId: 1,
                subscriptionId: "subscription-1",
            });
            transport.close(1000, "Browser test complete");
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    agentId: "codex",
                    requestId: "settings-before-disconnect",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-disconnect",
            });
            await evictDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), { webSockets: "hibernate" });
            daemon.close(1000, "Reconnect Runtime");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-before-disconnect",
                code: "runtime_offline",
            });
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: false });
            const reconnectResponse = await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                    headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
                }),
                environment,
            );
            expect(reconnectResponse.status).toBe(101);
            if (reconnectResponse.webSocket === null) {
                throw new Error("Expected the reconnected Runtime socket");
            }
            const reconnected = reconnectResponse.webSocket;
            const reconnectMessages = new SocketMessages(reconnected);
            reconnected.accept();
            expect(decodeServiceToDaemonMessage(await reconnectMessages.next()).kind).toBe("runtime.liveness.ready");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    agentId: "codex",
                    requestId: "settings-before-replacement",
                }),
            );
            expect(decodeServiceToDaemonMessage(await reconnectMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-replacement",
            });
            await evictDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), { webSockets: "hibernate" });
            const replacementResponse = await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                    headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
                }),
                environment,
            );
            expect(replacementResponse.status).toBe(101);
            if (replacementResponse.webSocket === null) {
                throw new Error("Expected the replacement Runtime socket");
            }
            const replacement = replacementResponse.webSocket;
            const replacementMessages = new SocketMessages(replacement);
            replacement.accept();
            try {
                expect(decodeServiceToDaemonMessage(await replacementMessages.next()).kind).toBe(
                    "runtime.liveness.ready",
                );
                expect(JSON.parse(await hostMessages.next())).toMatchObject({
                    kind: "agent.settings.discovery.failed",
                    requestId: "settings-before-replacement",
                    code: "runtime_offline",
                });
                expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            } finally {
                replacement.close(1000, "Test complete");
            }
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: false });
            await runInDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), async (_instance, state) => {
                const sessionTables = [
                    ...state.storage.sql.exec<{ name: string }>(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_bindings', 'session_configuration_snapshots', 'turns', 'attempts', 'interactions', 'pending_work', 'command_receipts', 'session_event_receipts', 'reliable_event_receipts', 'runtime_active_sessions', 'runtime_disconnect')",
                    ),
                ];
                expect(sessionTables).toEqual([]);
            });
            const sessionAccess = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                        {
                            body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                201,
            );
            const liveTarget = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/live-event-subscription-target`,
                        { headers: credentialHeaders(text(sessionAccess, "credential")) },
                    ),
                    environment,
                ),
                200,
            );
            expect(liveTarget).toMatchObject({ kind: "expiring", projectId, runtimeId });
        } finally {
            daemon.close(1000, "Test complete");
            host.close(1000, "Test complete");
        }
    }, 180_000);

    it("Given a machine with no discovered local Agent, When it redeems a Runtime pairing and publishes its catalog, Then pairing succeeds and the Runtime advertises an empty Agent directory", async () => {
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
                        displayName: "Unattended Runtime",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const projectId = text(
            await responseJson(
                await worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                        body: JSON.stringify({
                            displayName: "Unattended Project",
                            idempotencyKey: "unattended-project",
                            locationHint: "apac",
                        }),
                        headers: developerHeaders(),
                        method: "POST",
                    }),
                    environment,
                ),
                201,
            ),
            "projectId",
        );
        const pairing = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "unattended-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [],
                            futureClientField: "unknown keys are tolerated",
                            machineName: "Unattended Runtime",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "unattended-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const runtimeId = text(claimed, "runtimeId");
        const runtimeCredential = text(claimed, "runtimeCredential");

        expect(
            await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/agents`,
                        { headers: credentialHeaders(appCredential) },
                    ),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ agents: [], runtimeId });

        const catalogUpdate = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/channels/${text(claimed, "channelId")}/catalog`, {
                body: JSON.stringify({ agents: [], "ignored keys are tolerated": true }),
                headers: { authorization: `Bearer ${runtimeCredential}`, "content-type": "application/json" },
                method: "PUT",
            }),
            environment,
        );
        expect(catalogUpdate.status).toBe(204);
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/agents`,
                        { headers: credentialHeaders(appCredential) },
                    ),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ agents: [], runtimeId });
    });
});

describe.sequential("Platform Recording policy configuration", () => {
    /** Creates an App and Project through the production dashboard boundary. */
    async function createPolicyTarget(
        worker: ReturnType<typeof createTestMobiusPlatformApp>,
        environment: PlatformRelayBindings,
    ) {
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
                        displayName: "Recording enabled App",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
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
                        displayName: "Recording enabled Project",
                        idempotencyKey: `recording-enabled-${appId}`,
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        return { appId, projectId: text(project, "projectId") };
    }

    async function recordThroughRelay(projectId: string, sessionId: string, textContent: string) {
        return await runInDurableObject(env.RUNTIME_RELAY.getByName(projectId), async (_instance, state) => {
            const pending: Promise<void>[] = [];
            const database = new DurableObjectSqlDatabase(state.storage);
            const context = createPlatformDurableObjectContext(state, recordingBindings(), { database });
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

    /** Reads durable history back through the Recording Worker's own HTTP boundary. */
    async function readRecordedHistory(projectId: string, sessionId: string): Promise<Response> {
        const providerId = env.RECORDING_PROVIDER_ID;
        if (env.RECORDING === undefined || typeof providerId !== "string") {
            throw new Error("Expected the Recording provider binding");
        }
        return await env.RECORDING.fetch(
            new Request(
                `https://recording.internal/v1/projects/${projectId}/runtimes/${projectId}/sessions/${sessionId}/events`,
            ),
        );
    }

    it("Given an installed Recording provider, When a developer enables App policy, Then the Project inherits it and broadcasts are durably recorded", async () => {
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
        );
        const environment = recordingBindings();
        const { appId, projectId } = await createPolicyTarget(worker, environment);
        const appPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/recording-policy`;

        expect(
            await responseJson(
                await worker.fetch(new Request(appPolicyUrl, { headers: developerHeaders() }), environment),
                200,
            ),
        ).toEqual({
            effectiveMode: "disabled",
            inheritedFrom: "system",
            mode: "inherit",
            providerAvailable: true,
        });
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(appPolicyUrl, {
                        body: JSON.stringify({ mode: "enabled" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    }),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({
            effectiveMode: "enabled",
            inheritedFrom: "app",
            mode: "enabled",
            providerAvailable: true,
        });

        const projectPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/projects/${projectId}/recording-policy`;
        expect(
            await responseJson(
                await worker.fetch(new Request(projectPolicyUrl, { headers: developerHeaders() }), environment),
                200,
            ),
        ).toMatchObject({ effectiveMode: "enabled", inheritedFrom: "app", mode: "inherit" });

        await recordThroughRelay(projectId, "inherited-session", "inherited answer");
        const recorded = await readRecordedHistory(projectId, "inherited-session");
        expect(recorded.status).toBe(200);
        expect(decodeSessionRecordingHistory(await recorded.text())).toMatchObject({
            events: [{ payload: { content: { text: "inherited answer" } } }],
            sessionId: "inherited-session",
        });
    });

    it("Given an enabled App policy, When a Project overrides it as disabled, Then that Project's broadcasts are not recorded", async () => {
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
        );
        const environment = recordingBindings();
        const { appId, projectId } = await createPolicyTarget(worker, environment);
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
        const projectPolicyUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/projects/${projectId}/recording-policy`;
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(projectPolicyUrl, {
                        body: JSON.stringify({ mode: "disabled" }),
                        headers: developerHeaders(),
                        method: "PUT",
                    }),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ effectiveMode: "disabled", inheritedFrom: "project", mode: "disabled" });

        await recordThroughRelay(projectId, "disabled-session", "unrecorded answer");
        const recorded = await readRecordedHistory(projectId, "disabled-session");
        expect(recorded.status).toBe(404);
        await recorded.body?.cancel();
    });
});

/**
 * Pairs a Runtime, connects its daemon with liveness, and grants Chat access to one Session.
 *
 * Cloudflare stamps heartbeat answers with its own clock, which fake timers cannot move. With
 * `anchorClockToHeartbeat`, the daemon heartbeats once and the fake clock is set to that answer
 * before the Session credential is issued, so later times are explicit offsets from it.
 */
async function connectRuntimeDaemon(slug: string, options: { readonly anchorClockToHeartbeat?: boolean } = {}) {
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
                    displayName: `${slug} App`,
                    tenantId: text(record(tenantValues[0]), "tenantId"),
                }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const appCredential = text(record(app["defaultCredential"]), "credential");
    const project = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                body: JSON.stringify({
                    displayName: `${slug} Project`,
                    idempotencyKey: `${slug}-project`,
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
    const pairing = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                body: JSON.stringify({ idempotencyKey: `${slug}-runtime` }),
                headers: credentialHeaders(appCredential),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const claimed = await responseJson(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`, {
                body: JSON.stringify({
                    agents: readyAgents,
                    machineName: `${slug} Runtime`,
                    pairingCode: text(pairing, "pairingCode"),
                    workspaceName: `${slug}-workspace`,
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            environment,
        ),
        200,
    );
    const runtimeId = text(claimed, "runtimeId");
    const sessionId = `${slug}-session`;
    const daemonResponse = await worker.fetch(
        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
            headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
        }),
        environment,
    );
    if (daemonResponse.webSocket === null) {
        throw new Error("Expected the Runtime socket");
    }
    const daemon = daemonResponse.webSocket;
    const daemonMessages = new SocketMessages(daemon);
    const daemonClosed = new Promise<CloseEvent>((resolve) => {
        daemon.addEventListener("close", resolve, { once: true });
    });
    daemon.accept();
    expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
    /** Heartbeats exactly as the daemon does and returns when Cloudflare answered, by its own clock. */
    const heartbeat = async (): Promise<number> => {
        daemon.send(RUNTIME_HEARTBEAT_MESSAGE);
        expect(await daemonMessages.next()).toBe(RUNTIME_HEARTBEAT_ACK_MESSAGE);
        return await runInDurableObject(environment.RUNTIME_RELAY.getByName(runtimeId), (_instance, state) => {
            const socket = state.getWebSockets("daemon")[0];
            const answeredAt = socket === undefined ? null : state.getWebSocketAutoResponseTimestamp(socket);
            if (answeredAt === null) {
                throw new Error("Expected Cloudflare to have answered the heartbeat");
            }
            return answeredAt.getTime();
        });
    };
    if (options.anchorClockToHeartbeat === true) {
        vi.setSystemTime(await heartbeat());
    }
    const sessionAccess = await responseJson(
        await worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                {
                    body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                },
            ),
            environment,
        ),
        201,
    );
    return {
        projectId,
        sessionId,
        appSessionRequest: async (
            path: string,
            init: {
                readonly method: string;
                readonly body?: unknown;
                readonly credential?: string;
                readonly projectId?: string;
                readonly runtimeId?: string;
            },
        ) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${init.projectId ?? projectId}/runtimes/${init.runtimeId ?? runtimeId}/sessions/${sessionId}${path}`,
                    {
                        method: init.method,
                        headers: credentialHeaders(init.credential ?? appCredential),
                        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                    },
                ),
                environment,
            ),
        uploadContent: async (
            contentKey: string,
            bytes: Uint8Array,
            metadata: {
                readonly kind: "image" | "resource";
                readonly mediaType: string;
                readonly name: string;
                readonly uri: string;
            },
        ) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/content/${contentKey}?${new URLSearchParams({ uri: metadata.uri }).toString()}`,
                    {
                        body: bytes,
                        headers: {
                            authorization: `Bearer ${text(sessionAccess, "credential")}`,
                            "content-type": metadata.mediaType,
                            "x-mobius-byte-length": String(bytes.byteLength),
                            "x-mobius-content-kind": metadata.kind,
                            "x-mobius-file-name": encodeURIComponent(metadata.name),
                        },
                        method: "PUT",
                    },
                ),
                environment,
            ),
        issueAppCredential: async (permissions: readonly string[]) =>
            text(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/credentials`,
                            {
                                method: "POST",
                                headers: developerHeaders(),
                                body: JSON.stringify({ permissions, projectIds: [projectId] }),
                            },
                        ),
                        environment,
                    ),
                    201,
                ),
                "credential",
            ),
        rewriteCredentialLifetime: async (lifetimeMilliseconds: number) => {
            // Sign adversarial claims outside the SDK issuer, which refuses invalid lifetimes.
            const decoded = decodeSessionAccessCredential(text(sessionAccess, "credential"));
            const claims = {
                ...decoded.claims,
                expiresAtEpochMilliseconds: decoded.claims.issuedAtEpochMilliseconds + lifetimeMilliseconds,
            };
            const encode = (bytes: Uint8Array) =>
                btoa(String.fromCharCode(...bytes))
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/u, "");
            const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
            const signedValue = `msession_${decoded.publicCredentialId}_${payload}`;
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appCredential));
            const secretDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
                "",
            );
            const key = await crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(secretDigest),
                { hash: "SHA-256", name: "HMAC" },
                false,
                ["sign"],
            );
            const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedValue));
            return `${signedValue}_${encode(new Uint8Array(signature))}`;
        },
        daemon,
        daemonClosed,
        daemonMessages,
        heartbeat,
        readOnline: async () =>
            (
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/agents`,
                            {
                                headers: credentialHeaders(appCredential),
                            },
                        ),
                        environment,
                    ),
                    200,
                )
            )["online"],
        startTurn: (commandId: string, position: string) =>
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `${commandId}-started`,
                            position,
                            recordedAt: new Date().toISOString(),
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: `${commandId}-attempt`,
                                commandId,
                                epoch: `${slug}-epoch`,
                                kind: "prompt.started",
                            },
                        },
                    ],
                }),
            ),
        runtimeId,
        issueRuntimeCredential: async (targetRuntimeId: string) =>
            text(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                            {
                                method: "POST",
                                headers: credentialHeaders(appCredential),
                                body: JSON.stringify({ expiresInSeconds: 900, runtimeId: targetRuntimeId }),
                            },
                        ),
                        environment,
                    ),
                    201,
                ),
                "credential",
            ),
        queryActiveTurn: async (signal: AbortSignal) =>
            worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/active-turn`,
                    {
                        method: "POST",
                        headers: credentialHeaders(appCredential),
                        signal,
                        body: JSON.stringify({ additionalDirectoryIds: [], agentId: "codex", directoryId: "root" }),
                    },
                ),
                environment,
            ),
        readFile: async (path: string) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/files/content?${new URLSearchParams({ maxBytes: "1024", path }).toString()}`,
                    { headers: credentialHeaders(text(sessionAccess, "credential")) },
                ),
                environment,
            ),
        submitRuntimeTurn: (
            idempotencyKey: string,
            credentialTransform: (credential: string) => string = (credential) => credential,
            requestedSessionId: string = sessionId,
            destinationRuntimeId: string = runtimeId,
        ) =>
            env.RUNTIME_RELAY.getByName(destinationRuntimeId).fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${requestedSessionId}/turns`,
                    {
                        method: "POST",
                        headers: credentialHeaders(credentialTransform(text(sessionAccess, "credential"))),
                        body: JSON.stringify({
                            additionalDirectoryIds: [],
                            agentId: "codex",
                            content: "Direct execution",
                            directoryId: "root",
                            idempotencyKey,
                            attachments: [],
                        }),
                    },
                ),
            ),
        submitTurn: (idempotencyKey: string) =>
            worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`, {
                    body: JSON.stringify({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        content: `Run ${idempotencyKey}`,
                        directoryId: "root",
                        idempotencyKey,
                        attachments: [],
                    }),
                    headers: credentialHeaders(text(sessionAccess, "credential")),
                    method: "POST",
                }),
                environment,
            ),
    };
}

describe.sequential("Platform Turn submission", () => {
    // @no-uc: Compatibility; trusted backends must control a Runtime Session without delegated Session access.
    it.each([
        {
            label: "cancels the selected message",
            path: "/turns/app-command/cancel",
            method: "POST",
            body: { idempotencyKey: "cancel-app-command" },
            command: { commandId: "app-command", kind: "session.cancel" },
            payload: { commandId: "app-command", kind: "prompt.completed", stopReason: "cancelled" },
            expected: { turnId: "app-command", idempotencyKey: "cancel-app-command", state: { kind: "cancelled" } },
        },
        {
            label: "steers the selected queued message",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "steer" },
            command: { commandId: "app-command", disposition: "steer", kind: "session.prompt.disposition" },
            payload: { commandId: "app-command", attemptId: "app-attempt", epoch: "app-epoch", kind: "prompt.started" },
            expected: { turnId: "app-command" },
        },
        {
            label: "answers a pending permission request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "selected", optionId: "allow_once" },
            command: {
                interactionId: "app-interaction",
                kind: "session.permission.respond",
                outcome: "selected",
                optionId: "allow_once",
            },
            payload: {
                kind: "session.permission.resolved",
                event: {
                    interactionId: "app-interaction",
                    kind: "session.permission.resolved",
                    outcome: "selected",
                    optionId: "allow_once",
                    sessionId: "SESSION",
                },
            },
            expected: { accepted: true },
        },
        {
            label: "answers a pending elicitation request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "accept", content: '{"answer":"continue"}' },
            command: {
                interactionId: "app-interaction",
                kind: "session.elicitation.respond",
                action: "accept",
                content: '{"answer":"continue"}',
            },
            payload: {
                kind: "session.elicitation.resolved",
                event: {
                    interactionId: "app-interaction",
                    kind: "session.elicitation.resolved",
                    action: "accept",
                    sessionId: "SESSION",
                },
            },
            expected: { accepted: true },
        },
    ] as const)("App access $label", async (operation) => {
        const runtime = await connectRuntimeDaemon(`app-control-${operation.command.kind.replaceAll(".", "-")}`);
        try {
            const response = runtime.appSessionRequest(operation.path, operation);
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            expect(decodeServiceToDaemonMessage(first.message)).toMatchObject({
                ...operation.command,
                sessionId: runtime.sessionId,
            });
            const payload: LifecycleMetadata =
                operation.payload.kind === "session.permission.resolved"
                    ? {
                          kind: operation.payload.kind,
                          event: { ...operation.payload.event, sessionId: runtime.sessionId },
                      }
                    : operation.payload.kind === "session.elicitation.resolved"
                      ? {
                            kind: operation.payload.kind,
                            event: { ...operation.payload.event, sessionId: runtime.sessionId },
                        }
                      : operation.payload;
            runtime.daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "app-operation-resolved",
                            position: "1",
                            recordedAt: new Date().toISOString(),
                            sessionGenerationId: "session-generation-1",
                            sessionId: runtime.sessionId,
                            type: "lifecycle-metadata",
                            payload,
                        },
                    ],
                }),
            );
            expect(await responseJson(await response, 200)).toMatchObject(operation.expected);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Compatibility; legacy omission options must not reach older Runtimes under App access.
    it("App access restores a Runtime event page with read permission", async () => {
        const runtime = await connectRuntimeDaemon("app-history");
        try {
            const readOnly = await runtime.issueAppCredential(["session:read"]);
            const response = runtime.appSessionRequest(
                "/events-v2?limit=2&cursor=previous-event&omit=agent-reasoning",
                { method: "GET", credential: readOnly },
            );
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = decodeServiceToDaemonMessage(first.message);
            expect(command).toMatchObject({
                kind: "session.live-history.v2.page.load",
                sessionId: runtime.sessionId,
                eventLimit: 2,
                cursor: "previous-event",
            });
            if (command.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a history request");
            }
            expect(command.omit).toBeUndefined();
            const page = {
                events: [],
                nextCursor: "next-event",
                sessionGenerationId: "session-generation-1",
                tailCursor: "tail-event",
                truncated: true,
                version: 2 as const,
            };
            runtime.daemon.send(
                encodeSessionHistoryPageLoaded({
                    kind: "session.live-history.v2.page.loaded",
                    requestId: command.requestId,
                    sessionId: runtime.sessionId,
                    events: { events: page, queuedPromptRequests: [] },
                }),
            );
            expect(await responseJson(await response, 200)).toEqual(page);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given Runtime read permission, When an App reads Session configuration, Then the matching Runtime settings are returned without write permission", async () => {
        const runtime = await connectRuntimeDaemon("app-configuration-read");
        try {
            const readOnly = await runtime.issueAppCredential(["runtime:read"]);
            const response = runtime.appSessionRequest("/configuration", { method: "GET", credential: readOnly });
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = decodeServiceToDaemonMessage(first.message);
            expect(command).toMatchObject({ kind: "session.config.read", sessionId: runtime.sessionId });
            if (command.kind !== "session.config.read") {
                throw new Error("Expected a configuration request");
            }
            const result: SessionConfigReadResult = {
                kind: "session.config.read.result",
                requestId: command.requestId,
                sessionId: runtime.sessionId,
                configOptions: [],
            };
            runtime.daemon.send(encodeSessionConfigReadResult(result));
            expect(await responseJson(await response, 200)).toEqual(result);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; explicit Runtime targets must preserve credential permissions and project isolation.
    it("App access rejects unavailable permissions and targets before dispatch", async () => {
        const runtime = await connectRuntimeDaemon("app-permissions");
        const other = await connectRuntimeDaemon("app-permissions-other");
        try {
            const readOnly = await runtime.issueAppCredential(["session:read"]);
            for (const operation of [
                { path: "/turns/app-command/cancel", method: "POST", body: { idempotencyKey: "cancel-app-command" } },
                { path: "/turns/app-command/disposition", method: "PUT", body: { disposition: "steer" } },
                {
                    path: "/interactions/app-interaction/responses",
                    method: "POST",
                    body: { kind: "permission", responderId: "member-1", outcome: "cancelled", optionId: "" },
                },
            ]) {
                expect(
                    await responseJson(
                        await runtime.appSessionRequest(operation.path, { ...operation, credential: readOnly }),
                        403,
                    ),
                ).toMatchObject({ error: { code: "project_permission_denied" } });
            }
            const writeOnly = await runtime.issueAppCredential(["session:write"]);
            expect(
                await responseJson(
                    await runtime.appSessionRequest("/events-v2", { method: "GET", credential: writeOnly }),
                    403,
                ),
            ).toMatchObject({ error: { code: "project_permission_denied" } });
            expect(
                await responseJson(
                    await runtime.appSessionRequest("/events-v2", { method: "GET", projectId: other.projectId }),
                    403,
                ),
            ).toMatchObject({ error: { code: "project_access_denied" } });
            expect(
                await responseJson(
                    await runtime.appSessionRequest("/events-v2", { method: "GET", runtimeId: other.runtimeId }),
                    403,
                ),
            ).toMatchObject({ error: { code: "runtime_access_denied" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
            other.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Compatibility; malformed control requests must be distinguishable from retryable server failures.
    it.each([
        { label: "missing cancellation key", path: "/turns/app-command/cancel", method: "POST", body: {} },
        {
            label: "numeric cancellation key",
            path: "/turns/app-command/cancel",
            method: "POST",
            body: { idempotencyKey: 123 },
        },
        {
            label: "unsupported queue disposition",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "queue" },
        },
        {
            label: "invalid permission decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "unknown", optionId: "allow_once" },
        },
        {
            label: "invalid elicitation decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "unknown", content: "" },
        },
        { label: "empty event page", path: "/events-v2?limit=0", method: "GET" },
        { label: "empty event cursor", path: "/events-v2?cursor=", method: "GET" },
        { label: "unknown event omission", path: "/events-v2?omit=unknown", method: "GET" },
        { label: "malformed Runtime target", path: "/events-v2", method: "GET", runtimeId: "invalid%24runtime" },
    ])("App access reports $label as an invalid request", async (operation) => {
        const runtime = await connectRuntimeDaemon("app-invalid-request");
        try {
            expect(await responseJson(await runtime.appSessionRequest(operation.path, operation), 400)).toMatchObject({
                error: { code: "invalid_request" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("App access uploads raw attachment chunks before submitting a reference-only Turn", async () => {
        const runtime = await connectRuntimeDaemon("app-binary-attachment");
        try {
            const bytes = new Uint8Array(400 * 1024).map((_value, index) => index % 251);
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            const contentKey = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
            const metadata = {
                kind: "image" as const,
                mediaType: "image/png",
                name: "screenshot.png",
                uri: "attachment:///screenshot.png",
            };
            const upload = runtime.uploadContent(contentKey, bytes, metadata);
            const write = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            expect(write).toMatchObject({
                byteLength: bytes.byteLength,
                contentKey,
                contentKind: "image",
                kind: "content.write",
                sessionId: runtime.sessionId,
            });
            if (write.kind !== "content.write") {
                throw new Error("Expected a content write command");
            }
            runtime.daemon.send(
                encodeContentReadyEvent({
                    kind: "content.ready",
                    requestId: write.requestId,
                    sessionId: runtime.sessionId,
                }),
            );
            const chunks: Uint8Array[] = [];
            for (;;) {
                const frame = await runtime.daemonMessages.nextFrame();
                if (typeof frame === "string") {
                    const command = decodeServiceToDaemonMessage(frame);
                    if (command.kind === "content.commit" && command.requestId === write.requestId) {
                        break;
                    }
                    continue;
                }
                const arrayBuffer =
                    typeof frame === "object" && frame !== null ? Reflect.get(frame, "arrayBuffer") : undefined;
                const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, frame, []) : frame;
                const chunk = decodeContentChunkFrame(binary);
                expect(chunk.requestId).toBe(write.requestId);
                expect(chunk.sequence).toBe(chunks.length);
                chunks.push(chunk.bytes);
            }
            const uploadedBytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                uploadedBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            expect(uploadedBytes).toEqual(bytes);
            expect(chunks.length).toBeGreaterThan(1);
            runtime.daemon.send(
                encodeContentAvailableEvent({
                    byteLength: bytes.byteLength,
                    contentKey,
                    kind: "content.available",
                    requestId: write.requestId,
                    sessionId: runtime.sessionId,
                }),
            );
            const attachment = await responseJson(await upload, 200);
            const attachmentMetadata = {
                kind: metadata.kind,
                mimeType: metadata.mediaType,
                name: metadata.name,
                uri: metadata.uri,
            };
            expect(attachment).toEqual({ byteLength: bytes.byteLength, contentKey, ...attachmentMetadata });

            const idempotencyKey = "binary-attachment-turn";
            const response = runtime.appSessionRequest("/turns", {
                method: "POST",
                body: {
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    content: "Describe the pasted screenshot.",
                    directoryId: "root",
                    disposition: "reject",
                    idempotencyKey,
                    attachments: [attachment],
                    sessionConfigurations: [],
                    targetCommandId: "",
                },
            });
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const encodedPrompt = first.message;
            expect(encodedPrompt).not.toContain("base64");
            expect(encodedPrompt).not.toContain(String(bytes.slice(0, 32)));
            expect(decodeServiceToDaemonMessage(encodedPrompt)).toMatchObject({
                attachments: [{ byteLength: bytes.byteLength, contentKey, ...attachmentMetadata }],
                kind: "session.prompt",
                commandId: idempotencyKey,
            });
            runtime.startTurn(idempotencyKey, "1");
            expect(await responseJson(await response, 200)).toMatchObject({ turnId: idempotencyKey });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given a cancelled file response, When a late chunk arrives, Then the shared daemon remains available", async () => {
        const runtime = await connectRuntimeDaemon("cancelled-file-chunk");
        try {
            const pending = runtime.readFile("/workspace/image.png");
            const read = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (read.kind !== "file.read") {
                throw new Error("Expected a file read command");
            }
            runtime.daemon.send(
                encodeFileBeginEvent({
                    byteLength: 2,
                    kind: "file.begin",
                    mediaType: "image/png",
                    modifiedAt: "2026-09-18T00:00:00.000Z",
                    name: "image.png",
                    requestId: read.requestId,
                    sessionId: runtime.sessionId,
                }),
            );
            const response = await pending;
            await response.body?.cancel();

            runtime.daemon.send(
                encodeContentChunkFrame({
                    bytes: new Uint8Array([1, 2]),
                    requestId: read.requestId,
                    sequence: 0,
                }),
            );

            const query = runtime.queryActiveTurn(new AbortController().signal);
            const command = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (command.kind !== "native.session.request") {
                throw new Error("Expected an unrelated native query to reach the daemon");
            }
            runtime.daemon.send(
                encodeNativeSessionResult({
                    action: "active-turn",
                    kind: "native.session.result",
                    queued: [],
                    requestId: command.requestId,
                    sessionId: runtime.sessionId,
                    targetSessionId: runtime.sessionId,
                    turn: null,
                }),
            );
            expect(await responseJson(await query, 200)).toMatchObject({ action: "active-turn", turn: null });
            expect(runtime.daemon.readyState).toBe(WebSocket.OPEN);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; independent Durable Object clocks must not reject newly issued credentials.
    it.each([900, 30_000])(
        "accepts a Session credential issued %i milliseconds ahead of RuntimeRelay",
        async (skew) => {
            const runtime = await connectRuntimeDaemon(`clock-skew-${skew}`);
            try {
                vi.setSystemTime(Date.now() - skew);
                const submitted = runtime.submitRuntimeTurn("skewed-command");
                const first = await Promise.race([
                    runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
                    submitted.then((response) => ({ kind: "response" as const, response })),
                ]);
                if (first.kind === "response") {
                    throw new Error(
                        `Expected a daemon command, received ${first.response.status}: ${await first.response.text()}`,
                    );
                }
                expect(decodeServiceToDaemonMessage(first.message)).toMatchObject({
                    kind: "session.prompt",
                    commandId: "skewed-command",
                });
                runtime.startTurn("skewed-command", "1");
                expect(await responseJson(await submitted, 200)).toMatchObject({
                    idempotencyKey: "skewed-command",
                    state: { kind: "running" },
                });
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );
    // @no-uc: Technical regression; issuance tolerance must remain bounded and never extend expiry.
    it.each([
        { offset: -30_001, code: "project_credential_invalid" },
        { offset: 900_000, code: "credential_expired" },
    ])("refuses a credential at verifier offset $offset with $code", async ({ offset, code }) => {
        const runtime = await connectRuntimeDaemon(`clock-rejected-${Math.abs(offset)}`);
        try {
            vi.setSystemTime(Date.now() + offset);
            expect(await responseJson(await runtime.submitRuntimeTurn("invalid-time"), 401)).toMatchObject({
                error: { code },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    // @no-uc: Technical regression; future-time tolerance must not admit correctly signed invalid lifetimes.
    it.each([0, -1, 900_001])("refuses a signed credential with lifetime %i", async (lifetime) => {
        const runtime = await connectRuntimeDaemon(`invalid-lifetime-${Math.abs(lifetime)}`);
        try {
            const credential = await runtime.rewriteCredentialLifetime(lifetime);
            vi.setSystemTime(Date.now() - 900);
            expect(
                await responseJson(await runtime.submitRuntimeTurn("invalid-lifetime", () => credential), 401),
            ).toMatchObject({ error: { code: "project_credential_invalid" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an authorized token for another Project, When it selects an existing Runtime, Then that Runtime refuses the Project mismatch", async () => {
        const owner = await connectRuntimeDaemon("direct-owner");
        const other = await connectRuntimeDaemon("direct-other-project");
        try {
            const credential = await other.issueRuntimeCredential(owner.runtimeId);
            expect(
                await responseJson(
                    await other.submitRuntimeTurn("foreign-project", () => credential, undefined, owner.runtimeId),
                    403,
                ),
            ).toMatchObject({ error: { code: "runtime_access_denied" } });
        } finally {
            owner.daemon.close(1000, "Test complete");
            other.daemon.close(1000, "Test complete");
        }
    });
    it("Given an executing native query, When its HTTP caller cancels, Then cancellation reaches the daemon", async () => {
        const runtime = await connectRuntimeDaemon("direct-cancellation");
        const controller = new AbortController();
        try {
            const pending = runtime.queryActiveTurn(controller.signal).then(
                (response) => response.status,
                (cause: unknown) => cause,
            );
            const command = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (command.kind !== "native.session.request") {
                throw new Error("Expected a native query");
            }
            controller.abort(new DOMException("Caller left", "AbortError"));
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                kind: "native.session.cancel",
                requestId: command.requestId,
            });
            expect(await pending).toBeInstanceOf(DOMException);
        } finally {
            controller.abort();
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When direct Runtime HTTP receives a forged, wrong-Session, or expired credential, Then it rejects the request before execution", async () => {
        const runtime = await connectRuntimeDaemon("direct-authorization");
        try {
            expect(
                await responseJson(
                    await runtime.submitRuntimeTurn("forged", (credential) => `${credential.slice(0, -6)}AAAAAA`),
                    401,
                ),
            ).toMatchObject({ error: { code: "project_credential_invalid" } });
            expect(
                await responseJson(
                    await runtime.submitRuntimeTurn("wrong-session", (credential) => credential, "different-session"),
                    403,
                ),
            ).toMatchObject({ error: { code: "project_permission_denied" } });
            vi.setSystemTime(new Date("2026-09-18T00:16:00.000Z"));
            expect(await responseJson(await runtime.submitRuntimeTurn("expired"), 401)).toMatchObject({
                error: { code: "credential_expired" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When HTTP reaches RuntimeRelay directly, Then the command executes without a project relay hop and remains correlated", async () => {
        const runtime = await connectRuntimeDaemon("direct-runtime");
        try {
            const submitted = runtime.submitRuntimeTurn("direct-command");
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                submitted.then((response) => ({ kind: "response", message: String(response.status) })),
            ]);
            expect(first.kind).toBe("command");
            expect(decodeServiceToDaemonMessage(first.message)).toMatchObject({
                kind: "session.prompt",
                commandId: "direct-command",
            });
            runtime.startTurn("direct-command", "1");
            expect(await responseJson(await submitted, 200)).toMatchObject({ state: { kind: "running" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a linked Runtime, When Chat submits a first Turn longer than 10,000 characters or an invalid Turn, Then the long Turn reaches the Runtime and the invalid Turn is rejected as a client error", async () => {
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
                        displayName: "Long prompt App",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                    body: JSON.stringify({
                        displayName: "Long prompt Project",
                        idempotencyKey: "long-prompt-project",
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
        const pairing = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "long-prompt-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
                    {
                        body: JSON.stringify({
                            agents: readyAgents,
                            machineName: "Long prompt Runtime",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "long-prompt-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const runtimeId = text(claimed, "runtimeId");
        const sessionId = "long-prompt-session";
        const daemonResponse = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
            }),
            environment,
        );
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Runtime socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            const sessionAccess = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                        {
                            body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                201,
            );
            const submitTurn = (idempotencyKey: string, content: string, attachments: readonly unknown[]) =>
                worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                        {
                            body: JSON.stringify({
                                additionalDirectoryIds: [],
                                agentId: "codex",
                                content,
                                directoryId: "root",
                                idempotencyKey,
                                attachments,
                            }),
                            headers: credentialHeaders(text(sessionAccess, "credential")),
                            method: "POST",
                        },
                    ),
                    environment,
                );

            // First Turns carry the teammate's instructions ahead of the user's message.
            const longPrompt = `${"instruction ".repeat(2_000)}\n\nsummarize the workspace`;
            expect(longPrompt.length).toBeGreaterThan(20_000);
            const longTurn = submitTurn("long-first-turn", longPrompt, []);
            const delivered = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (delivered.kind !== "session.prompt") {
                throw new Error("Expected the long Turn to reach the Runtime");
            }
            expect(delivered.prompt).toBe(longPrompt);
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "long-first-started",
                            position: "1",
                            recordedAt: "2026-09-18T00:00:00.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: "long-first-attempt",
                                commandId: delivered.commandId,
                                epoch: "long-prompt-epoch",
                                kind: "prompt.started",
                            },
                        },
                    ],
                }),
            );
            expect(await responseJson(await longTurn, 200)).toMatchObject({
                state: { kind: "running" },
                turnId: "long-first-turn",
            });

            // A pending cancellation waits for the whole Turn, so an unrelated
            // Turn's failure broadcast must not disturb it.
            const cancelTurn = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns/long-first-turn/cancel`,
                    {
                        body: JSON.stringify({ idempotencyKey: "cancel-long-first" }),
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
                environment,
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.cancel");
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "unrelated-turn-failed",
                            position: "2",
                            recordedAt: "2026-09-18T00:00:01.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: "unrelated-attempt",
                                code: "agent_execution_failed",
                                commandId: "unrelated-turn",
                                kind: "prompt.failed",
                                message: "The local agent could not complete the request",
                            },
                        },
                    ],
                }),
            );
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "long-first-completed",
                            position: "3",
                            recordedAt: "2026-09-18T00:00:02.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: {
                                commandId: "long-first-turn",
                                kind: "prompt.completed",
                                stopReason: "cancelled",
                            },
                        },
                    ],
                }),
            );
            expect(await responseJson(await cancelTurn, 200)).toMatchObject({
                state: { kind: "cancelled" },
                turnId: "long-first-turn",
            });

            // A queue-disposition Turn is acknowledged by the V2 queue change
            // the daemon records as the prompt enters its queue.
            const queuedTurn = worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`, {
                    body: JSON.stringify({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        content: "queue this follow-up",
                        directoryId: "root",
                        disposition: "queue",
                        idempotencyKey: "queued-follow-up",
                        attachments: [],
                        targetCommandId: "long-first-turn",
                    }),
                    headers: credentialHeaders(text(sessionAccess, "credential")),
                    method: "POST",
                }),
                environment,
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.prompt");
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "queued-follow-up-admitted",
                            position: "4",
                            recordedAt: "2026-09-18T00:00:03.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: { kind: "session.queue.changed" },
                        },
                    ],
                }),
            );
            expect(await responseJson(await queuedTurn, 200)).toMatchObject({
                state: { kind: "queued" },
                turnId: "queued-follow-up",
            });

            // A queue change on another Session of the same Runtime must not
            // acknowledge the submission: without Session scoping this Turn
            // would settle as queued from the foreign event instead of waiting
            // for its own prompt.started.
            const crossSessionTurn = worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`, {
                    body: JSON.stringify({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        content: "queue behind the foreign queue change",
                        directoryId: "root",
                        disposition: "queue",
                        idempotencyKey: "cross-session-queued",
                        attachments: [],
                        targetCommandId: "long-first-turn",
                    }),
                    headers: credentialHeaders(text(sessionAccess, "credential")),
                    method: "POST",
                }),
                environment,
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.prompt");
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "foreign-session-queue-change",
                            position: "1",
                            recordedAt: "2026-09-18T00:00:04.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId: "another-session",
                            type: "lifecycle-metadata",
                            payload: { kind: "session.queue.changed" },
                        },
                    ],
                }),
            );
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "cross-session-queued-started",
                            position: "5",
                            recordedAt: "2026-09-18T00:00:05.000Z",
                            sessionGenerationId: "session-generation-1",
                            sessionId,
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: "cross-session-attempt",
                                commandId: "cross-session-queued",
                                epoch: "cross-session-epoch",
                                kind: "prompt.started",
                            },
                        },
                    ],
                }),
            );
            expect(await responseJson(await crossSessionTurn, 200)).toMatchObject({
                state: { kind: "running" },
                turnId: "cross-session-queued",
            });

            expect(
                await responseJson(await submitTurn("invalid-image-turn", "describe this", [{ kind: "image" }]), 400),
            ).toMatchObject({ error: { code: "invalid_request" } });
            expect(await responseJson(await submitTurn("oversized-turn", "x".repeat(100_001), []), 400)).toMatchObject({
                error: { code: "invalid_request" },
            });
            expect(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/turns`,
                            {
                                body: JSON.stringify({
                                    additionalDirectoryIds: [],
                                    agentId: "codex",
                                    content: "describe this",
                                    directoryId: "root",
                                    disposition: "reject",
                                    idempotencyKey: "invalid-runtime-turn",
                                    attachments: [{ kind: "image" }],
                                    sessionConfigurations: [],
                                    targetCommandId: "",
                                }),
                                headers: credentialHeaders(appCredential),
                                method: "POST",
                            },
                        ),
                        environment,
                    ),
                    400,
                ),
            ).toMatchObject({ error: { code: "invalid_request" } });
        } finally {
            daemon.close();
        }
    });

    it("Given an Agent whose capability advertisement withholds steering and Session renaming, When Chat steers a Turn or renames the Session, Then the Relay forwards both and the Runtime's own answer decides", async () => {
        const gatedAgent = readyAgents[0];
        if (gatedAgent === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
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
                        displayName: "Capability-gated commands App",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Capability-gated commands Project",
                        idempotencyKey: "capability-gated-commands-project",
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
        const pairing = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "capability-gated-commands-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [
                                {
                                    ...gatedAgent,
                                    // The Agent withholds both command capabilities, so pairing
                                    // must still succeed and only the commands are rejected.
                                    capabilities: {
                                        ...gatedAgent.capabilities,
                                        renameSession: false,
                                        steering: false,
                                    },
                                },
                            ],
                            machineName: "Capability-gated commands Runtime",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "capability-gated-commands-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const runtimeId = text(claimed, "runtimeId");
        const sessionId = "capability-gated-session";
        const sessionAccess = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`,
                    {
                        body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
                        headers: credentialHeaders(appCredential),
                        method: "POST",
                    },
                ),
                environment,
            ),
            201,
        );
        const sessionCredential = text(sessionAccess, "credential");

        // Pairing succeeded, so the Agent remains listed with its capabilities.
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/agents`,
                        { headers: credentialHeaders(appCredential) },
                    ),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ agents: [{ id: "codex", label: "Codex" }], runtimeId });

        // The Relay no longer decides from the catalog. It forwards the steer
        // to the Runtime, whose own rejection answers with the same
        // machine-readable code and a terminal status.
        const daemonResponse = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                headers: { authorization: `Bearer ${text(claimed, "runtimeCredential")}`, Upgrade: "websocket" },
            }),
            environment,
        );
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Runtime socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            const steer = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns/some-active-turn/disposition`,
                    {
                        body: JSON.stringify({ disposition: "steer" }),
                        headers: credentialHeaders(sessionCredential),
                        method: "PUT",
                    },
                ),
                environment,
            );
            const forwarded = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(forwarded).toMatchObject({ kind: "session.prompt.disposition", sessionId });
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "steering_unsupported",
                    kind: "session.operation.failed",
                    message: "The selected agent does not support mid-turn steering",
                    requestId: "some-active-turn",
                    sessionId,
                }),
            );
            expect(await responseJson(await steer, 409)).toMatchObject({
                error: { code: "steering_unsupported" },
            });

            // A rename forwards unchanged even though no listed Agent
            // advertises renaming: the Runtime renames the stored Session
            // itself, exactly as it does for Agents without the extension.
            const rename = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/rename`,
                    {
                        body: JSON.stringify({ title: "Renamed despite the withheld capability" }),
                        headers: credentialHeaders(sessionCredential),
                        method: "POST",
                    },
                ),
                environment,
            );
            const renameCommand = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(renameCommand).toMatchObject({ kind: "session.rename", sessionId });
            daemon.send(
                encodeSessionRenamedEvent({
                    kind: "session.renamed",
                    requestId: renameCommand.kind === "session.rename" ? renameCommand.requestId : "",
                    sessionId,
                    title: "Renamed despite the withheld capability",
                    updatedAt: "2030-01-01T00:00:00.000Z",
                }),
            );
            expect(await responseJson(await rename, 200)).toMatchObject({
                kind: "session.renamed",
                sessionId,
                title: "Renamed despite the withheld capability",
            });
        } finally {
            daemon.close(1000, "Test complete");
        }
    });

    it("Given an Agent whose capability advertisement carries values the Relay cannot interpret, When it pairs, Then pairing succeeds and the unreadable capabilities stay withheld", async () => {
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
                        displayName: "Malformed capabilities App",
                        tenantId: text(record(tenantValues[0]), "tenantId"),
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Malformed capabilities Project",
                        idempotencyKey: "malformed-capabilities-project",
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
        const pairing = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "malformed-capabilities-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const advertised = readyAgents[0];
        if (advertised === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
        const malformed = {
            ...advertised,
            capabilities: {
                ...advertised.capabilities,
                // Non-boolean advertisement values used to reject the whole
                // pairing; they now stay withheld instead.
                renameSession: "yes",
                steering: null,
            },
        };
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [malformed],
                            machineName: "Malformed capabilities Runtime",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "malformed-capabilities-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        expect(
            await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${text(claimed, "runtimeId")}/agents`,
                        { headers: credentialHeaders(appCredential) },
                    ),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({
            agents: [
                {
                    capabilities: { renameSession: false, steering: false },
                    id: "codex",
                },
            ],
            runtimeId: text(claimed, "runtimeId"),
        });
    });

    it("Given a daemon that heartbeats and then falls silent, When Chat submits Turns, Then they reach it while it heartbeats and are refused as runtime_offline once the silence outlasts the heartbeat deadline", async () => {
        const runtime = await connectRuntimeDaemon("silent-daemon", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 20_000);
            const delivered = runtime.submitTurn("heartbeating-turn");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "heartbeating-turn",
                kind: "session.prompt",
            });
            runtime.startTurn("heartbeating-turn", "1");
            expect(await responseJson(await delivered, 200)).toMatchObject({ turnId: "heartbeating-turn" });

            // A Turn sent before the deadline still reaches the connection, which never answers it.
            vi.setSystemTime(heartbeatAt + 30_000);
            const stranded = runtime.submitTurn("stranded-turn");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "stranded-turn",
                kind: "session.prompt",
            });

            // Once the silence outlasts the deadline, the next Turn is refused at once and releases the stranded one.
            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await responseJson(await runtime.submitTurn("after-silence-turn"), 503)).toMatchObject({
                error: { code: "runtime_offline" },
            });
            expect(await responseJson(await stranded, 503)).toMatchObject({ error: { code: "runtime_offline" } });
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            // Cloudflare's clock has not reached the times set above, and the run does not finish
            // tearing down while the test clock is still ahead of it.
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon whose heartbeats stopped, When an app reads the Runtime, Then it is reported offline and its connection is closed", async () => {
        const runtime = await connectRuntimeDaemon("silent-presence", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 30_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon released before heartbeats became fixed text, When it heartbeats with an identifier and then falls silent, Then the Relay acknowledges that heartbeat and reports the Runtime offline once the silence outlasts the deadline", async () => {
        const runtime = await connectRuntimeDaemon("identified-heartbeat");
        try {
            const heartbeatAt = Date.now();
            // The exact text such a daemon sends; Cloudflare does not answer it, so the Relay must.
            runtime.daemon.send(JSON.stringify({ heartbeatId: "identified-heartbeat", kind: "runtime.heartbeat" }));
            expect(JSON.parse(await runtime.daemonMessages.next())).toEqual({
                heartbeatId: "identified-heartbeat",
                kind: "runtime.heartbeat.ack",
            });
            vi.setSystemTime(heartbeatAt + 30_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            runtime.daemon.close();
        }
    });

    it("Given a daemon that has never sent a heartbeat, When Chat submits a Turn long after it connected, Then the Relay still delivers the Turn to it", async () => {
        const runtime = await connectRuntimeDaemon("unproven-daemon");
        try {
            vi.setSystemTime(Date.now() + 10 * 60_000);
            expect(await runtime.readOnline()).toBe(true);
            const delivered = runtime.submitTurn("unproven-turn");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "unproven-turn",
                kind: "session.prompt",
            });
            runtime.startTurn("unproven-turn", "1");
            expect(await responseJson(await delivered, 200)).toMatchObject({ turnId: "unproven-turn" });
        } finally {
            runtime.daemon.close();
        }
    });
});
