import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    decodeSessionEventEnvelopeV2,
    decodeSessionPromptCommand,
    decodeSessionRecordingHistory,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    encodeSessionEventEnvelopeV2,
    encodeSessionInfoUpdatedEvent,
    encodeSessionLiveHistoryV2PageLoaded,
    encodeSessionOperationFailedEvent,
    encodeSessionPreviewHistoryPageLoaded,
    encodeSessionPromptCommand,
    encodeSessionStatusChangedEvent,
    encodeSessionsQueriedEvent,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import {
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    RuntimeRelay,
    type SessionRecording,
} from "@moxt-ai/mobius-relay-core";
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

class ControlledRecording implements SessionRecording {
    readonly started = Promise.withResolvers<void>();
    readonly release = Promise.withResolvers<void>();
    readonly contents: string[] = [];
    #first = true;

    readonly deliver: SessionRecording["deliver"] = async (_target, envelope, signal) => {
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
            return { kind: "failed", code: "write_failed" };
        }
        this.contents.push(...envelope.events.map((event) => JSON.stringify(event)));
        return { kind: "recorded" };
    };
}

function liveEvent(sessionId: string, text: string): string {
    return encodeSessionEventEnvelopeV2({
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                position: "1",
                provenance: { kind: "original" },
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
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                throw new Error("Expected a text WebSocket message");
            }
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.#resolvers.push(resolve))
            : Promise.resolve(message);
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

    it("Given a linked Codex Runtime, When Chat configures and prompts a Session, Then the configuration, answer, and connection status arrive without cloud Session storage", async () => {
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
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
                    {
                        body: JSON.stringify({
                            agents: readyAgents,
                            installableAgents: [],
                            machineName: "Private reconnect Runtime",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "private-reconnect-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
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
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtimes/${runtimeId}/host?token=${appCredential}`,
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
                    images: [],
                    kind: "session.prompt",
                    prompt: "show the local answer",
                    resources: [],
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
            const received = decodeSessionEventEnvelopeV2(await hostMessages.next());
            expect(JSON.stringify(received.events.map((event) => event.payload))).toContain("local answer");
            expect(received).not.toHaveProperty("cursor");
            expect(received).not.toHaveProperty("sequence");
            // Relay broadcasts the original V2 identity unchanged, including duplicate frames.
            daemon.send(answer);
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelopeV2(await hostMessages.next()).events.map((event) => event.payload),
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
                    decodeSessionEventEnvelopeV2(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("recording is stalled");
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelopeV2(await hostMessages.next()).events.map((event) => event.payload),
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
                provenance: { kind: "original" as const },
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                sessionId,
                type: "acp" as const,
            };
            const secondRawEvent = { ...rawEvent, eventId: "event-v2-2", position: "2" };
            daemon.send(encodeSessionEventEnvelopeV2({ events: [rawEvent, secondRawEvent], kind: "session.event.v2" }));
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "session.event.v2" });
            expect(JSON.parse(await v2Messages.next())).toEqual([rawEvent, secondRawEvent]);
            const historyResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/events-v2?limit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const query = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (query.kind !== "session.query") {
                throw new Error("Expected a Session query before loading V2 history");
            }
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("session.query");
            daemon.send(
                encodeSessionsQueriedEvent({
                    entries: [
                        {
                            additionalDirectories: [],
                            agentId: "codex",
                            directoryId: "root",
                            directoryLabel: "Workspace",
                            prompted: true,
                            sessionId,
                            status: { kind: "idle" },
                            title: "Local session",
                            updatedAt: "2026-09-18T00:00:00.000Z",
                        },
                    ],
                    kind: "session.queried",
                    requestId: query.requestId,
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next()).kind).toBe("session.queried");
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
            const historyLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (historyLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a V2 Session history request");
            }
            daemon.send(
                encodeSessionLiveHistoryV2PageLoaded({
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
                }),
            );
            expect(await responseJson(await historyResponse, 200)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [rawEvent],
                nextCursor: null,
                tailCursor: rawEvent.eventId,
                truncated: false,
                version: 2,
            });
            const previewHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/native-events-preview?agentId=codex&directoryId=root&eventLimit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const previewHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (previewHistoryLoad.kind !== "session.preview-history.page.load") {
                throw new Error("Expected a native Session preview history request");
            }
            daemon.send(
                encodeSessionPreviewHistoryPageLoaded({
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
                }),
            );
            expect(await responseJson(await previewHistoryResponse, 200)).toEqual({
                events: {
                    sessionGenerationId: "native-session-generation-1",
                    events: [rawEvent],
                    nextCursor: null,
                    tailCursor: rawEvent.eventId,
                    truncated: false,
                    version: 2,
                },
                queuedPromptRequests: [],
            });
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
                    decodeSessionEventEnvelopeV2(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("local answer");
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                data: expect.stringContaining("local answer"),
                eventId: "",
                kind: "session.events.event",
                subscriptionId: "subscription-1",
            });
            transport.close(1000, "Browser test complete");
            daemon.close(1000, "Reconnect Runtime");
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
            reconnected.close(1000, "Test complete");
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
