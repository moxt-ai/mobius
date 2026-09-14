import { env } from "cloudflare:workers";
import {
    BotExecutionBindingApprovedEvent,
    decodeBotExecutionBindingApprovalRequest,
    decodeBotSessionPromptCommand,
    decodeNativeSessionCommand,
    decodeSessionConfigureCommand,
    decodeSessionEventAcknowledgement,
    encodeBotExecutionBindingApprovedEvent,
    encodeNativeSessionResult,
    encodeSessionConfigUpdatedEvent,
    encodeSessionEventEnvelope,
    encodeSessionOperationFailedEvent,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core";
import {
    createMobiusConversationSession,
    MobiusApiError,
    MobiusBrowserAccessToken,
    MobiusPageRequest,
} from "@moxt-ai/mobius-sdk/browser";
import {
    MobiusAppCredentialProvider,
    MobiusOidcCredentialProvider,
    MobiusPlatformAppClient,
    MobiusPlatformDeveloperClient,
} from "@moxt-ai/mobius-sdk/platform";
import {
    MobiusBotOwnerClient,
    MobiusClient,
    MobiusRuntimePairingRequest,
    MobiusRuntimePairingWaitOptions,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import configuredPlatformWorker, {
    createPlatformWorker,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
    type PlatformWorker,
} from "../src/worker.ts";

const relayOrigin = "https://platform.test";
const thirdPartyBrowserOrigin = "https://app.example.test";
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
    },
];

interface PlatformProjectFixture {
    readonly appCredential: string;
    readonly appId: string;
    readonly channelId: string;
    readonly daemonToken: string;
    readonly environment: PlatformRelayBindings;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;
    readonly worker: PlatformWorker;
}

interface PlatformConversationFixture extends PlatformProjectFixture {
    readonly botId: string;
    readonly conversationId: string;
    readonly sessionId: string;
    readonly socket: WebSocket;
    readonly socketMessages: SocketMessages;
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
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
    };
}

class DeveloperAuthenticator implements ExternalIdentityAuthenticator {
    #available = true;

    readonly disable = (): void => {
        this.#available = false;
    };

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        if (!this.#available) {
            throw new ProjectAuthenticationError("external_provider_unavailable", "The provider is unavailable");
        }
        if (credential.providerId !== "clerk" || credential.credential !== "developer-token") {
            throw new ProjectAuthenticationError("external_identity_invalid", "The identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://identity.example.test",
            "developer-1",
            new Map(),
            Date.now(),
            Date.now() + 3_600_000,
        );
    };
}

class PlatformWorkerTransport {
    readonly #environment: PlatformRelayBindings;
    readonly #worker: PlatformWorker;

    constructor(worker: PlatformWorker, environment: PlatformRelayBindings) {
        this.#environment = environment;
        this.#worker = worker;
    }

    readonly fetch = async (request: Request): Promise<Response> =>
        await this.#worker.fetch(request, this.#environment);
}

function bindings(): PlatformRelayBindings {
    return {
        BOT_CONNECTIONS: env.BOT_CONNECTIONS,
        D1_SHARD_APAC_01: env.D1_SHARD_APAC_01,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
        SESSION_RELAY: env.SESSION_RELAY,
    };
}

function developerHeaders(): HeadersInit {
    return {
        authorization: "Bearer developer-token",
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    };
}

function credentialHeaders(credential: string): HeadersInit {
    return { authorization: `Bearer ${credential}`, "content-type": "application/json" };
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

function integerField(value: Readonly<Record<string, unknown>>, name: string): number {
    const field = value[name];
    if (typeof field !== "number" || !Number.isSafeInteger(field)) {
        throw new Error(`Expected ${name}`);
    }
    return field;
}

async function json(response: Response, expectedStatus: number): Promise<Readonly<Record<string, unknown>>> {
    const detail = response.status === expectedStatus ? "" : await response.clone().text();
    expect(response.status, detail).toBe(expectedStatus);
    return record(await response.json());
}

async function provisionPlatformProject(label: string): Promise<PlatformProjectFixture> {
    const worker = createPlatformWorker(
        new PlatformAuthenticationConfiguration(
            new DeveloperAuthenticator(),
            new Set(["developer-1"]),
            new Set([thirdPartyBrowserOrigin]),
        ),
    );
    const environment = bindings();
    const tenant = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                body: JSON.stringify({ displayName: `Tenant ${label}` }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const tenantId = text(tenant, "tenantId");
    const app = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                body: JSON.stringify({ displayName: `App ${label}`, tenantId }),
                headers: developerHeaders(),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const appId = text(app, "appId");
    const appCredential = text(record(app["defaultCredential"]), "credential");
    const project = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                body: JSON.stringify({
                    displayName: `Project ${label}`,
                    idempotencyKey: `project-${label}`,
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
    const pairing = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                body: JSON.stringify({ idempotencyKey: `runtime-${label}` }),
                headers: credentialHeaders(appCredential),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const claimed = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`, {
                body: JSON.stringify({
                    agents: readyAgents,
                    installableAgents: [],
                    machineName: `Runtime ${label}`,
                    pairingCode: text(pairing, "pairingCode"),
                    workspaceName: `workspace-${label}`,
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            environment,
        ),
        200,
    );
    return {
        appCredential,
        appId,
        channelId: text(pairing, "channelId"),
        daemonToken: text(claimed, "runtimeCredential"),
        environment,
        projectId,
        runtimeId: text(pairing, "runtimeId"),
        tenantId,
        worker,
    };
}

it("Given existing App keys with past expiration dates, When storage is migrated and the keys are used, Then the active key authenticates and the revoked key stays rejected", async () => {
    const fixture = await provisionPlatformProject("legacy-app-keys");
    const developer = new MobiusPlatformDeveloperClient({
        authenticationProviderId: "clerk",
        credentialProvider: new MobiusOidcCredentialProvider("developer-token"),
        endpoint: relayOrigin,
        transport: new PlatformWorkerTransport(fixture.worker, fixture.environment),
    });
    const revoked = await developer.issueAppCredential(
        fixture.appId,
        { permissions: ["bot:read"], projectIds: [fixture.projectId] },
        AbortSignal.timeout(5_000),
    );
    await developer.revokeAppCredential(revoked.credentialId, AbortSignal.timeout(5_000));
    const migration = env.TEST_PLATFORM_MIGRATIONS.find((item) => item.name === "0005_non_expiring_app_keys.sql");
    if (migration === undefined) {
        throw new Error("Missing non-expiring App keys migration");
    }
    const database = env.PLATFORM_DIRECTORY_DATABASE;
    // Recreate the legacy persisted representation before applying the real migration.
    // The batch rolls back the schema and data together if any migration statement fails.
    await database.batch([
        database.prepare("ALTER TABLE platform_app_credentials ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"),
        database.prepare("DROP INDEX platform_app_credentials_lookup"),
        database.prepare(
            "CREATE INDEX platform_app_credentials_lookup ON platform_app_credentials(public_credential_id, revoked_at, expires_at, overlap_ends_at)",
        ),
        database
            .prepare("UPDATE platform_app_credentials SET expires_at = ? WHERE app_id = ?")
            .bind(Date.parse("2026-09-09T00:00:00.000Z"), fixture.appId),
        ...migration.queries.map((query) => database.prepare(query)),
    ]);
    vi.setSystemTime(new Date("2036-09-14T00:00:00.000Z"));
    for (const { credential, status } of [
        { credential: fixture.appCredential, status: 200 },
        { credential: revoked.credential, status: 401 },
    ]) {
        const response = await fixture.worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/bots`, {
                headers: credentialHeaders(credential),
            }),
            fixture.environment,
        );
        expect(response.status).toBe(status);
    }
});

it("Given an App-wide server credential, When its backend provisions a user Project twice, Then the same Project is returned without developer sign-in", async () => {
    const fixture = await provisionPlatformProject("app-provision");
    const request = () =>
        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${fixture.appId}/projects`, {
            method: "POST",
            headers: credentialHeaders(fixture.appCredential),
            body: JSON.stringify({
                displayName: "Anonymous workspace",
                clientReference: "anonymous-user",
                idempotencyKey: "anonymous-user",
                locationHint: "apac",
            }),
        });
    const project = await json(await fixture.worker.fetch(request(), fixture.environment), 201);
    expect(project["appId"]).toBe(fixture.appId);
    expect(project["clientReference"]).toBe("anonymous-user");
    expect(await json(await fixture.worker.fetch(request(), fixture.environment), 201)).toEqual(project);
    const signal = new AbortController().signal;
    const client = new MobiusPlatformAppClient({
        endpoint: relayOrigin,
        credentialProvider: new MobiusAppCredentialProvider(fixture.appCredential),
        transport: { fetch: async (request) => await fixture.worker.fetch(request, fixture.environment) },
    });
    expect(
        (
            await client.createProject(
                fixture.appId,
                {
                    displayName: "Anonymous workspace",
                    clientReference: "anonymous-user",
                    idempotencyKey: "anonymous-user",
                    locationHint: "apac",
                },
                signal,
            )
        ).projectId,
    ).toBe(project["projectId"]);
    const other = await provisionPlatformProject("other-app-provision");
    expect(
        (
            await fixture.worker.fetch(
                new Request(request(), { headers: credentialHeaders(other.appCredential) }),
                fixture.environment,
            )
        ).status,
    ).toBe(403);
    expect(
        (
            await fixture.worker.fetch(
                new Request(request(), {
                    headers: { ...credentialHeaders(fixture.appCredential), "x-mobius-oidc-provider": "clerk" },
                }),
                fixture.environment,
            )
        ).status,
    ).toBe(400);
    const scoped = await json(
        await fixture.worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${fixture.appId}/credentials`, {
                method: "POST",
                headers: developerHeaders(),
                body: JSON.stringify({
                    permissions: ["project:read"],
                    projectIds: [fixture.projectId],
                }),
            }),
            fixture.environment,
        ),
        201,
    );
    const scopedRequest = new Request(request(), { headers: credentialHeaders(text(scoped, "credential")) });
    expect((await fixture.worker.fetch(scopedRequest, fixture.environment)).status).toBe(403);
    const denied = await fixture.worker.fetch(
        new Request(request(), { headers: { "content-type": "application/json" } }),
        fixture.environment,
    );
    expect(denied.status).toBe(401);
    for (const input of [
        {
            displayName: "Unknown location",
            clientReference: "unknown-location",
            idempotencyKey: "unknown-location",
            locationHint: "unknown",
        },
        {
            displayName: "Physical placement",
            clientReference: "physical-placement",
            idempotencyKey: "physical-placement",
            placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
        },
    ]) {
        const rejected = await fixture.worker.fetch(
            new Request(request(), { body: JSON.stringify(input) }),
            fixture.environment,
        );
        expect(rejected.status).toBe(400);
    }
});

async function createReadyConversation(label: string): Promise<PlatformConversationFixture> {
    const project = await provisionPlatformProject(label);
    const bot = await json(
        await project.worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots`, {
                body: JSON.stringify({ avatarRef: "", description: "Conversation browser test", displayName: label }),
                headers: credentialHeaders(project.appCredential),
                method: "POST",
            }),
            project.environment,
        ),
        201,
    );
    const botId = text(bot, "botId");
    const behavior = await json(
        await project.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots/${botId}/behavior-revisions`,
                {
                    body: JSON.stringify({
                        agentConfiguration: {},
                        expectedRevision: 0,
                        instructions: "Answer from the approved local Runtime.",
                        requiredCapabilities: ["embedded-context"],
                    }),
                    headers: credentialHeaders(project.appCredential),
                    method: "POST",
                },
            ),
            project.environment,
        ),
        201,
    );
    const daemonResponse = await project.worker.fetch(
        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect`, {
            headers: { Authorization: `Bearer ${project.daemonToken}`, Upgrade: "websocket" },
        }),
        project.environment,
    );
    expect(daemonResponse.status).toBe(101);
    const socket = daemonResponse.webSocket;
    if (socket === null) {
        throw new Error("Expected a Runtime WebSocket");
    }
    const socketMessages = new SocketMessages(socket);
    socket.accept();
    await json(
        await project.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots/${botId}/execution-bindings`,
                {
                    body: JSON.stringify({
                        agentConfigRevision: 1,
                        agentRef: "codex",
                        allowedDeliveryTargetIds: [],
                        behaviorRevisionId: text(behavior, "behaviorRevisionId"),
                        completionPolicy: { kind: "none" },
                        expectedRevision: integerField(bot, "lifecycleRevision"),
                        runtimeId: project.runtimeId,
                        workspaceRef: "default",
                    }),
                    headers: credentialHeaders(project.appCredential),
                    method: "POST",
                },
            ),
            project.environment,
        ),
        202,
    );
    const approval = decodeBotExecutionBindingApprovalRequest(await socketMessages.next());
    const approved = new BotExecutionBindingApprovedEvent(
        approval.requestId,
        approval.botId,
        approval.behaviorRevisionId,
        approval.bindingId,
        approval.bindingRevision,
        `grant_${botId}`,
        "a".repeat(64),
        "b".repeat(64),
    );
    socket.send(encodeBotExecutionBindingApprovedEvent(approved));
    expect(await socketMessages.next()).toBe(encodeBotExecutionBindingApprovedEvent(approved));
    const conversation = await json(
        await project.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots/${botId}/conversations`,
                {
                    body: JSON.stringify({ clientConversationKey: `conversation-${label}` }),
                    headers: credentialHeaders(project.appCredential),
                    method: "POST",
                },
            ),
            project.environment,
        ),
        201,
    );
    return {
        ...project,
        botId,
        conversationId: text(conversation, "conversationId"),
        sessionId: text(conversation, "sessionId"),
        socket,
        socketMessages,
    };
}

function attemptEvent(
    sessionId: string,
    commandId: string,
    eventId: string,
    kind: string,
    attemptId: string,
    sourceSequence: number,
): SessionEventEnvelope {
    const payload =
        kind === SESSION_STARTED_KIND
            ? { attemptId, commandId, kind: SESSION_STARTED_KIND, sessionId }
            : { commandId, kind: SESSION_COMPLETED_KIND, sessionId, stopReason: "end_turn" };
    return {
        eventId,
        kind: SESSION_EVENT_KIND,
        payload: JSON.stringify(payload),
        sessionId,
        source: { attemptId, kind: "attempt", sourceSeq: sourceSequence.toString() },
    };
}

async function commitRuntimeEvent(fixture: PlatformConversationFixture, event: SessionEventEnvelope): Promise<void> {
    fixture.socket.send(encodeSessionEventEnvelope(event));
    expect(decodeSessionEventAcknowledgement(await fixture.socketMessages.next())).toMatchObject({
        duplicate: false,
        eventId: event.eventId,
        sessionId: event.sessionId,
    });
}

it.each([[thirdPartyBrowserOrigin], ["*"]])(
    "Given a permitted Platform browser origin %j, When a developer preflights and manages tenants and apps, Then CORS permits the requests while authentication remains required",
    async (allowedOrigin) => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(), new Set([allowedOrigin])),
        );
        const environment = bindings();
        const headers = new Headers(developerHeaders());
        headers.set("origin", thirdPartyBrowserOrigin);
        const base = `${relayOrigin}${MOBIUS_API_PREFIX}`;
        for (const route of [
            "/v1/platform/tenants",
            "/v1/apps",
            "/v1/apps/example/credentials",
            "/v1/platform/app-credentials/example/revoke",
        ]) {
            for (const method of ["GET", "POST", "PUT", "DELETE"]) {
                const response = await worker.fetch(
                    new Request(`${base}${route}`, {
                        method: "OPTIONS",
                        headers: {
                            origin: thirdPartyBrowserOrigin,
                            "access-control-request-method": method,
                            "access-control-request-headers": "Authorization, Content-Type, X-Mobius-Oidc-Provider",
                        },
                    }),
                    environment,
                );
                expect(response.status).toBe(204);
                expect(response.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
                expect(response.headers.get("access-control-allow-methods")).toContain(method);
                expect(response.headers.get("access-control-allow-headers")).toContain("x-mobius-oidc-provider");
                expect(response.headers.get("vary")).toContain("Origin");
            }
        }
        const unauthenticated = await worker.fetch(
            new Request(`${base}/v1/platform/tenants`, { headers: { origin: thirdPartyBrowserOrigin } }),
            environment,
        );
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        const tenantResponse = await worker.fetch(
            new Request(`${base}/v1/platform/tenants`, {
                method: "POST",
                headers,
                body: JSON.stringify({ displayName: "Browser workspace" }),
            }),
            environment,
        );
        expect(tenantResponse.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        const tenant = await json(tenantResponse, 201);
        const appResponse = await worker.fetch(
            new Request(`${base}/v1/apps`, {
                method: "POST",
                headers,
                body: JSON.stringify({ displayName: "Browser app", tenantId: text(tenant, "tenantId") }),
            }),
            environment,
        );
        expect(appResponse.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        const app = await json(appResponse, 201);
        const appUrl = `${base}/v1/apps/${text(app, "appId")}`;
        const renamed = await worker.fetch(
            new Request(appUrl, {
                method: "PUT",
                headers,
                body: JSON.stringify({ displayName: "Renamed browser app" }),
            }),
            environment,
        );
        expect(renamed.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        expect(await json(renamed, 200)).toMatchObject({ displayName: "Renamed browser app" });
        const removed = await worker.fetch(new Request(appUrl, { method: "DELETE", headers }), environment);
        expect(removed.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        await json(removed, 200);
    },
);

it("Given a Platform origin allowlist, When a browser requests an untrusted origin or unsupported preflight, Then the control API rejects it without CORS permission", async () => {
    const worker = createPlatformWorker(
        new PlatformAuthenticationConfiguration(
            new DeveloperAuthenticator(),
            new Set(),
            new Set([thirdPartyBrowserOrigin]),
        ),
    );
    const cases: readonly (readonly [string, string, string, string])[] = [
        ["https://untrusted.example.test", "POST", "authorization", "browser_origin_denied"],
        ["", "POST", "authorization", "browser_origin_denied"],
        [thirdPartyBrowserOrigin, "PATCH", "authorization", "browser_preflight_denied"],
        [thirdPartyBrowserOrigin, "POST", "x-untrusted-header", "browser_preflight_denied"],
    ];
    for (const [origin, method, requestedHeaders, code] of cases) {
        const response = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                method: "OPTIONS",
                headers: {
                    origin,
                    "access-control-request-method": method,
                    "access-control-request-headers": requestedHeaders,
                },
            }),
            bindings(),
        );
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(await json(response, 403)).toMatchObject({ error: { code } });
    }
});

it("Given an App-owned Session, When its backend issues browser access, Then the browser reads only that Session and cannot discover or rebind Runtime sessions", async () => {
    const fixture = await createReadyConversation("session-scoped-browser");
    try {
        const issued = await json(
            await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/sessions/${fixture.sessionId}/access-credentials`,
                    {
                        method: "POST",
                        headers: credentialHeaders(fixture.appCredential),
                        body: JSON.stringify({ expiresInSeconds: 600 }),
                    },
                ),
                fixture.environment,
            ),
            201,
        );
        const headers = credentialHeaders(text(issued, "credential"));
        const base = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}`;
        const preflight = await fixture.worker.fetch(
            new Request(`${base}/sessions/${fixture.sessionId}/prepare`, {
                method: "OPTIONS",
                headers: {
                    origin: thirdPartyBrowserOrigin,
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "authorization,content-type",
                },
            }),
            fixture.environment,
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        expect(
            (
                await fixture.worker.fetch(
                    new Request(`${base}/sessions/${fixture.sessionId}`, { headers }),
                    fixture.environment,
                )
            ).status,
        ).toBe(200);
        for (const path of ["missing-artifact", "missing-artifact/content"]) {
            expect(
                (
                    await fixture.worker.fetch(
                        new Request(`${base}/sessions/${fixture.sessionId}/artifacts/${path}`, { headers }),
                        fixture.environment,
                    )
                ).status,
            ).toBe(404);
        }
        for (const path of ["sessions", "runtimes", "sessions/another-session"]) {
            expect(
                (await fixture.worker.fetch(new Request(`${base}/${path}`, { headers }), fixture.environment)).status,
            ).toBe(403);
        }
        expect(
            (
                await fixture.worker.fetch(
                    new Request(`${base}/sessions/${fixture.sessionId}/binding`, {
                        method: "PUT",
                        headers,
                        body: JSON.stringify({
                            bindingId: "other-binding",
                            runtimeId: fixture.runtimeId,
                            agentRef: "codex",
                            workspaceRef: "default",
                            configRevision: 1,
                        }),
                    }),
                    fixture.environment,
                )
            ).status,
        ).toBe(403);
        const streamController = new AbortController();
        const streamHeaders = new Headers(headers);
        streamHeaders.set("origin", thirdPartyBrowserOrigin);
        streamHeaders.set("accept", "text/event-stream");
        const stream = await fixture.worker.fetch(
            new Request(`${base}/sessions/${fixture.sessionId}/events`, {
                headers: streamHeaders,
                signal: streamController.signal,
            }),
            fixture.environment,
        );
        expect(stream.status).toBe(200);
        expect(stream.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
        streamController.abort();
        await stream.body?.cancel();
        const browser = new MobiusClient({
            endpoint: relayOrigin,
            projectId: fixture.projectId,
            credentialProvider: new StaticMobiusCredentialProvider(text(issued, "credential")),
            transport: new PlatformWorkerTransport(fixture.worker, fixture.environment),
        });
        try {
            const turn = await browser.turns.submit(
                fixture.sessionId,
                {
                    idempotencyKey: "scoped-message",
                    content: "Hello native session",
                    images: [],
                    resources: [],
                    artifactIds: [],
                    additionalDirectoryIds: [],
                },
                new AbortController().signal,
            );
            expect(turn.sessionId).toBe(fixture.sessionId);
            expect(turn.content).toBe("Hello native session");
            await expect(
                browser.turns.submit(
                    "another-session",
                    {
                        idempotencyKey: "denied-message",
                        content: "Denied",
                        images: [],
                        resources: [],
                        artifactIds: [],
                        additionalDirectoryIds: [],
                    },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ status: 403 });
            vi.setSystemTime(new Date("2026-09-10T00:11:00.000Z"));
            await expect(browser.sessions.read(fixture.sessionId, new AbortController().signal)).rejects.toMatchObject({
                status: 401,
            });
        } finally {
            browser.close();
        }
    } finally {
        fixture.socket.close();
    }
});

it("Given a paired native Agent, When the App backend discovers sessions, Then Mobius returns the Runtime inventory without issuing a host credential", async () => {
    const fixture = await createReadyConversation("native-discovery-backend");
    const client = new MobiusClient({
        endpoint: relayOrigin,
        projectId: fixture.projectId,
        credentialProvider: new MobiusAppCredentialProvider(fixture.appCredential),
        transport: new PlatformWorkerTransport(fixture.worker, fixture.environment),
    });
    try {
        const pending = client.runtimes.nativeSessions(
            fixture.runtimeId,
            {
                action: "list",
                agentId: "codex",
                directoryId: "default",
                additionalDirectoryIds: [],
                cursor: null,
                discoveryId: null,
            },
            new AbortController().signal,
        );
        const request = decodeNativeSessionCommand(await fixture.socketMessages.next());
        const agent = readyAgents[0];
        if (agent === undefined) {
            throw new Error("The Runtime agent is unavailable");
        }
        fixture.socket.send(
            encodeNativeSessionResult({
                kind: "native.session.result",
                action: "list",
                requestId: request.requestId,
                sessionId: request.sessionId,
                capabilities: agent.capabilities,
                entries: [
                    {
                        entryId: "native-history",
                        title: "Native history",
                        directoryId: "default",
                        directoryLabel: "Workspace",
                        additionalDirectories: [],
                        updatedAt: null,
                    },
                ],
                nextCursor: null,
            }),
        );
        const result = await pending;
        expect(result.action).toBe("list");
        expect(result).not.toHaveProperty("hostToken");
        const importing = client.runtimes.nativeSessions(
            fixture.runtimeId,
            {
                action: "import",
                agentId: "codex",
                directoryId: "default",
                additionalDirectoryIds: [],
                entryId: "native-history",
                discoveryId: result.sessionId,
            },
            new AbortController().signal,
        );
        const selected = decodeNativeSessionCommand(await fixture.socketMessages.next());
        if (selected.action !== "import") {
            throw new Error("Choose a native session to import");
        }
        if (selected.sessionId !== request.sessionId || selected.entryId !== "native-history") {
            fixture.socket.send(
                encodeSessionOperationFailedEvent({
                    kind: "session.operation.failed",
                    requestId: selected.requestId,
                    sessionId: selected.sessionId,
                    code: "native_session_not_found",
                    message: "The discovered entry is unavailable",
                }),
            );
        } else {
            fixture.socket.send(
                encodeNativeSessionResult({
                    kind: "native.session.result",
                    action: "import",
                    requestId: selected.requestId,
                    sessionId: selected.sessionId,
                    targetSessionId: selected.targetSessionId,
                    title: "Native history",
                    history: { status: "unavailable" },
                    ready: {
                        kind: "session.ready",
                        requestId: selected.requestId,
                        sessionId: fixture.sessionId,
                        agentId: "codex",
                        agentName: "Codex",
                        agentVersion: "1",
                        directoryId: "default",
                        directoryLabel: "Workspace",
                        additionalDirectories: [],
                        capabilities: agent.capabilities,
                        commands: [],
                        configOptions: [],
                        restored: true,
                    },
                }),
            );
        }
        const imported = await importing;
        expect(imported.action).toBe("import");
        if (imported.action !== "import") {
            throw new Error("The session is not resumable");
        }
        expect(imported.ready.sessionId).toBe(fixture.sessionId);
    } finally {
        client.close();
        fixture.socket.close();
    }
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Platform hosting boundary", () => {
    it("Given a Project Bot and an uninitialized unrelated shard, When its owner reads and updates it using the Project endpoint and SDK, Then the Bot remains available in its own Project", async () => {
        const fixture = await provisionPlatformProject("project-routed-bot");
        const environment = { ...fixture.environment, D1_SHARD_WNAM_01: env.TEST_UNINITIALIZED_SHARD };
        const owner = new MobiusBotOwnerClient({
            credentialProvider: new StaticMobiusCredentialProvider(fixture.appCredential),
            endpoint: relayOrigin,
            projectId: fixture.projectId,
            transport: new PlatformWorkerTransport(fixture.worker, environment),
        });
        const signal = AbortSignal.timeout(5_000);
        const bot = await owner.createBot({ displayName: "Routed Bot", description: "", avatarRef: "" }, signal);
        const response = await fixture.worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/bots/${bot.botId}`, {
                headers: credentialHeaders(fixture.appCredential),
            }),
            environment,
        );
        expect(await json(response, 200)).toMatchObject({ botId: bot.botId, projectId: fixture.projectId });
        expect(await owner.readBot(bot.botId, signal)).toMatchObject({ displayName: "Routed Bot" });
        await owner.reviseProfile(
            bot.botId,
            { displayName: "Updated routed Bot", description: "Project-scoped", avatarRef: "", expectedRevision: 1 },
            signal,
        );
        expect(await owner.readBot(bot.botId, signal)).toMatchObject({ displayName: "Updated routed Bot" });
        expect(await owner.listBindings(bot.botId, signal)).toMatchObject({ executionBindings: [] });
        expect(await owner.listConversations(bot.botId, signal)).toMatchObject({ conversations: [] });
    });

    it("Given two Projects sharing a shard, When an owner supplies the other Project's Bot ID, Then reads and updates are rejected and the Bot is unchanged", async () => {
        const fixture = await provisionPlatformProject("project-routing-isolation");
        const transport = new PlatformWorkerTransport(fixture.worker, fixture.environment);
        const app = new MobiusPlatformAppClient({
            credentialProvider: new MobiusAppCredentialProvider(fixture.appCredential),
            endpoint: relayOrigin,
            transport,
        });
        const signal = AbortSignal.timeout(5_000);
        const other = await app.createProject(
            fixture.appId,
            {
                clientReference: "other-project",
                idempotencyKey: "other-project",
                displayName: "Other",
                locationHint: "apac",
            },
            signal,
        );
        const owner = new MobiusBotOwnerClient({
            credentialProvider: new StaticMobiusCredentialProvider(fixture.appCredential),
            endpoint: relayOrigin,
            projectId: fixture.projectId,
            transport,
        });
        const otherOwner = new MobiusBotOwnerClient({
            credentialProvider: new StaticMobiusCredentialProvider(fixture.appCredential),
            endpoint: relayOrigin,
            projectId: other.projectId,
            transport,
        });
        const bot = await otherOwner.createBot({ displayName: "Other Bot", description: "", avatarRef: "" }, signal);
        await expect(owner.readBot(bot.botId, signal)).rejects.toMatchObject({ status: 404, code: "bot_not_found" });
        await expect(
            owner.reviseProfile(
                bot.botId,
                { displayName: "Wrong Project", description: "", avatarRef: "", expectedRevision: 1 },
                signal,
            ),
        ).rejects.toMatchObject({ status: 404, code: "bot_not_found" });
        expect(await otherOwner.readBot(bot.botId, signal)).toMatchObject({
            displayName: "Other Bot",
            projectId: other.projectId,
        });
        const grant = await json(
            await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${other.projectId}/bots/${bot.botId}/connection-grants`,
                    {
                        method: "POST",
                        headers: credentialHeaders(fixture.appCredential),
                        body: JSON.stringify({
                            audience: "routing-test",
                            label: "Routing",
                            scopes: ["inbound-conversation:create"],
                            expiresInSeconds: 600,
                        }),
                    },
                ),
                fixture.environment,
            ),
            201,
        );
        const connection = await json(
            await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connection-grants/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        audience: "routing-test",
                        connectorPrincipalId: "routing-connector",
                        grantId: text(grant, "grantId"),
                        grantSecret: text(grant, "grantSecret"),
                    }),
                }),
                fixture.environment,
            ),
            201,
        );
        const denied = await fixture.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/bots/${bot.botId}/conversations`,
                {
                    method: "POST",
                    headers: credentialHeaders(text(connection, "credential")),
                    body: JSON.stringify({
                        clientConversationKey: "wrong-project",
                        replyDeliveryTargetId: "target_missing",
                        title: "Wrong Project",
                    }),
                },
            ),
            fixture.environment,
        );
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ error: { code: "conversation_access_denied" } });
    });

    it("Given a Bot binding with an invalid Runtime directory identifier, When the Platform receives it, Then it rejects the request before persisting an approval", async () => {
        const project = await provisionPlatformProject("invalid-binding-directory");
        const bot = await json(
            await project.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots`, {
                    body: JSON.stringify({
                        avatarRef: "",
                        description: "Invalid binding directory test",
                        displayName: "Invalid binding directory",
                    }),
                    headers: credentialHeaders(project.appCredential),
                    method: "POST",
                }),
                project.environment,
            ),
            201,
        );
        const behavior = await json(
            await project.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots/${text(bot, "botId")}/behavior-revisions`,
                    {
                        body: JSON.stringify({
                            agentConfiguration: {},
                            expectedRevision: 0,
                            instructions: "Run only in an approved Runtime directory.",
                            requiredCapabilities: [],
                        }),
                        headers: credentialHeaders(project.appCredential),
                        method: "POST",
                    },
                ),
                project.environment,
            ),
            201,
        );

        const response = await project.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/bots/${text(bot, "botId")}/execution-bindings`,
                {
                    body: JSON.stringify({
                        agentConfigRevision: 1,
                        agentRef: "codex",
                        allowedDeliveryTargetIds: [],
                        behaviorRevisionId: text(behavior, "behaviorRevisionId"),
                        completionPolicy: { kind: "none" },
                        expectedRevision: integerField(bot, "lifecycleRevision"),
                        runtimeId: project.runtimeId,
                        workspaceRef: ".",
                    }),
                    headers: credentialHeaders(project.appCredential),
                    method: "POST",
                },
            ),
            project.environment,
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
        const persisted = await project.environment.D1_SHARD_APAC_01.prepare(
            `SELECT COUNT(*) AS count FROM bot_execution_bindings WHERE bot_id = ?`,
        )
            .bind(text(bot, "botId"))
            .first<{ readonly count: number }>();
        expect(persisted?.count).toBe(0);
    });

    it("Given invalid or oversized JSON, When a client posts to a Platform route, Then the request is rejected with a bounded body error", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        for (const path of [
            "/v1/platform/app-credentials/credential-test/revoke",
            "/v1/client/session/turns/turn-test/promote",
        ]) {
            for (const input of [
                { body: "{", contentType: "application/json", status: 400 },
                { body: "null", contentType: "application/json", status: 400 },
                { body: "[]", contentType: "application/json", status: 400 },
                { body: '{"extra":true}', contentType: "application/json", status: 400 },
                { body: "{}", contentType: "text/plain", status: 400 },
                {
                    body: JSON.stringify({ extra: "é".repeat(128 * 1024) }),
                    contentType: "application/json",
                    status: 413,
                },
            ]) {
                const response = await worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}${path}`, {
                        method: "POST",
                        headers: { "content-type": input.contentType },
                        body: input.body,
                    }),
                    bindings(),
                );
                expect(response.status, `${path}: ${input.contentType}, ${input.body.slice(0, 40)}`).toBe(input.status);
                await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
            }
        }
    });

    it("Given malformed Platform request fields, When a client submits JSON, Then the route rejects the body before authorizing an operation", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        for (const [path, body] of [
            ["/v1/platform/tenants", { displayName: 12 }],
            ["/v1/apps/app-test/projects", { displayName: "Project", idempotencyKey: false }],
            ["/v1/apps/app-test/credentials", { permissions: [], projectIds: [12] }],
            [
                "/v1/client/session/configuration",
                {
                    additionalDirectoryIds: [],
                    booleanValue: "false",
                    configId: "mode",
                    idempotencyKey: "key",
                    value: "",
                    valueType: "boolean",
                },
            ],
            [
                "/v1/client/session/artifacts",
                { byteLength: -1, mediaType: "text/plain", name: "file.txt", sha256: "a".repeat(64) },
            ],
            [
                "/v1/client/session/interactions/interaction-test/response",
                { kind: "permission", optionId: "allow", outcome: "selected", content: "extra" },
            ],
        ]) {
            const response = await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}${path}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                }),
                bindings(),
            );
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
        }
    });

    it("Given a Platform deployment, When health, capabilities, and developer authentication are requested, Then Platform is discoverable and developer authentication is enforced", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        const health = await json(
            await worker.fetch(new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/health`), bindings()),
            200,
        );
        expect(health).toEqual({ service: "mobius-relay-platform", status: "ok" });

        const capabilities = await json(
            await worker.fetch(new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/capabilities`), bindings()),
            200,
        );
        expect(capabilities).toMatchObject({
            hosting: { anonymousPublicBootstrap: false, profile: "platform" },
            resources: { apps: true, conversationAccessCredentials: true, projects: true, tenants: true },
        });

        const configuredEnvironment = {
            ...bindings(),
            MOBIUS_PLATFORM_ALLOWED_ORIGINS: JSON.stringify([thirdPartyBrowserOrigin]),
            MOBIUS_PLATFORM_OIDC_PROVIDERS: JSON.stringify([
                {
                    audience: "mobius-platform",
                    issuer: "https://identity.example.test",
                    jwksUrl: "https://identity.example.test/.well-known/jwks.json",
                    providerId: "clerk",
                },
            ]),
            MOBIUS_PLATFORM_OPERATOR_SUBJECTS: JSON.stringify(["developer-1"]),
        };
        const configuredAuthentication = await configuredPlatformWorker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                body: JSON.stringify({ displayName: "Configured tenant" }),
                headers: developerHeaders(),
                method: "POST",
            }),
            configuredEnvironment,
        );
        expect(configuredAuthentication.status).toBe(401);
        await expect(configuredAuthentication.json()).resolves.toMatchObject({
            error: { code: "developer_authentication_failed" },
        });
    });

    it("Given the split SDK entry points, When a backend provisions and pairs a Project, Then OIDC, AppCredential, idempotency, and server capabilities remain separated", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        const environment = bindings();
        const transport = new PlatformWorkerTransport(worker, environment);
        const developer = new MobiusPlatformDeveloperClient({
            authenticationProviderId: "clerk",
            credentialProvider: new MobiusOidcCredentialProvider("developer-token"),
            endpoint: relayOrigin,
            transport,
        });
        const tenant = await developer.createTenant("SDK tenant", AbortSignal.timeout(5_000));
        const app = await developer.createApp(tenant.tenantId, "SDK app", AbortSignal.timeout(5_000));
        expect((await developer.readApp(app.appId, AbortSignal.timeout(5_000))).appId).toBe(app.appId);
        const configuration = await developer.readConfiguration(AbortSignal.timeout(5_000));
        expect(configuration.allowedOrigins).toEqual([]);
        const projectRequest = {
            clientReference: "sdk-customer",
            displayName: "SDK project",
            idempotencyKey: "sdk-project",
            locationHint: "apac",
        };
        const project = await developer.createProject(app.appId, projectRequest, AbortSignal.timeout(5_000));
        const replay = await developer.createProject(app.appId, projectRequest, AbortSignal.timeout(5_000));
        expect(replay.projectId).toBe(project.projectId);
        expect(
            (await developer.listApps(tenant.tenantId, AbortSignal.timeout(5_000))).map((item) => item.appId),
        ).toEqual([app.appId]);
        expect(
            (await developer.listProjects(app.appId, AbortSignal.timeout(5_000))).map((item) => item.projectId),
        ).toEqual([project.projectId]);

        const service = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(app.defaultCredential.credential),
            endpoint: relayOrigin,
            projectId: project.projectId,
            transport,
        });
        const pairing = await service.runtimePairings.create(
            new MobiusRuntimePairingRequest("sdk-runtime"),
            AbortSignal.timeout(5_000),
        );
        expect(pairing.projectId).toBe(project.projectId);

        const scoped = await developer.issueAppCredential(
            app.appId,
            {
                permissions: ["bot:read", "conversation:read"],
                projectIds: [project.projectId],
            },
            AbortSignal.timeout(5_000),
        );
        const rotated = await developer.rotateAppCredential(scoped.credentialId, 60, AbortSignal.timeout(5_000));
        expect(rotated.replacedCredentialId).toBe(scoped.credentialId);
        expect(
            (await developer.revokeAppCredential(rotated.credentialId, AbortSignal.timeout(5_000))).credentialId,
        ).toBe(rotated.credentialId);
        service.close();
    });

    it("Given an authenticated developer, When they manage Tenants, Apps, and keys, Then only their active resources and secret-on-create credentials are exposed", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        const developer = new MobiusPlatformDeveloperClient({
            authenticationProviderId: "clerk",
            credentialProvider: new MobiusOidcCredentialProvider("developer-token"),
            endpoint: relayOrigin,
            transport: new PlatformWorkerTransport(worker, bindings()),
        });

        const tenant = await developer.createTenant("First tenant", AbortSignal.timeout(5_000));
        expect((await developer.listTenants(AbortSignal.timeout(5_000))).map((item) => item.tenantId)).toContain(
            tenant.tenantId,
        );
        expect((await developer.readTenant(tenant.tenantId, AbortSignal.timeout(5_000))).displayName).toBe(
            "First tenant",
        );
        expect(
            (await developer.updateTenant(tenant.tenantId, "Renamed tenant", AbortSignal.timeout(5_000))).displayName,
        ).toBe("Renamed tenant");

        const app = await developer.createApp(tenant.tenantId, "First app", AbortSignal.timeout(5_000));
        expect(app.appId).toMatch(/^app_/);
        expect(app.defaultCredential.credential).toMatch(/^mapp_/);
        expect(app.defaultCredential).not.toHaveProperty("expiresAt");
        expect((await developer.updateApp(app.appId, "Renamed app", AbortSignal.timeout(5_000))).displayName).toBe(
            "Renamed app",
        );
        const second = await developer.issueAppCredential(
            app.appId,
            { permissions: ["project:read"], projectIds: [] },
            AbortSignal.timeout(5_000),
        );
        expect(second.credential).toMatch(/^mapp_/);
        expect(second.credential).not.toBe(app.defaultCredential.credential);
        const credentials = await developer.listAppCredentials(app.appId, AbortSignal.timeout(5_000));
        for (const credential of credentials) {
            expect(credential).not.toHaveProperty("expiresAt");
        }
        expect(credentials.map((credential) => credential.credentialId)).toEqual(
            expect.arrayContaining([second.credentialId, app.defaultCredential.credentialId]),
        );
        expect(JSON.stringify(credentials)).not.toContain("mapp_");

        const deletedApp = await developer.deleteApp(app.appId, AbortSignal.timeout(5_000));
        expect(deletedApp.lifecycle).toBe("deleted");
        expect(await developer.listApps(tenant.tenantId, AbortSignal.timeout(5_000))).toEqual([]);
        const deletedTenant = await developer.deleteTenant(tenant.tenantId, AbortSignal.timeout(5_000));
        expect(deletedTenant.lifecycle).toBe("deleted");
        expect((await developer.listTenants(AbortSignal.timeout(5_000))).map((item) => item.tenantId)).not.toContain(
            tenant.tenantId,
        );
    });

    it("Given an approved Project Bot, When the server SDK creates and operates a Conversation, Then it persists the Conversation, dispatches commands, and returns a reusable event cursor", async () => {
        const fixture = await createReadyConversation("server-sdk-conversation");
        try {
            const owner = new MobiusBotOwnerClient({
                actorReference: "server-sdk-owner",
                credentialProvider: new StaticMobiusCredentialProvider(fixture.appCredential),
                endpoint: relayOrigin,
                projectId: fixture.projectId,
                transport: new PlatformWorkerTransport(fixture.worker, fixture.environment),
            });
            const created = await owner.createProjectConversation(
                {
                    botId: fixture.botId,
                    clientReference: "server-sdk-customer-conversation",
                    configuration: {
                        additionalDirectoryIds: [],
                        booleanValue: false,
                        configId: "model",
                        value: "codex",
                        valueType: "select",
                    },
                    idempotencyKey: "server-sdk-create-conversation",
                    title: "Server SDK Conversation",
                },
                AbortSignal.timeout(5_000),
            );
            expect(created).toMatchObject({
                botId: fixture.botId,
                clientReference: "server-sdk-customer-conversation",
                idempotencyKey: "server-sdk-create-conversation",
                lifecycle: "active",
                projectId: fixture.projectId,
                title: "Server SDK Conversation",
            });
            expect(decodeSessionConfigureCommand(await fixture.socketMessages.next())).toMatchObject({
                configId: "model",
                requestId: "server-sdk-create-conversation",
                sessionId: created.sessionId,
                value: "codex",
            });

            expect(
                await owner.readProjectConversation(created.conversationId, AbortSignal.timeout(5_000)),
            ).toMatchObject({
                clientReference: created.clientReference,
                conversationId: created.conversationId,
                sessionId: created.sessionId,
            });

            const accepted = await owner.submitProjectConversationTurn(
                created.conversationId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Answer through the shared server SDK contract.",
                    idempotencyKey: "server-sdk-turn",
                    images: [],
                    resources: [],
                },
                AbortSignal.timeout(5_000),
            );
            expect(accepted).toMatchObject({ duplicate: false });
            expect(decodeBotSessionPromptCommand(await fixture.socketMessages.next())).toMatchObject({
                botId: fixture.botId,
                commandId: "server-sdk-turn",
                conversationId: created.conversationId,
                executionId: accepted.executionId,
                sessionId: created.sessionId,
                turnId: accepted.turnId,
            });
            expect(
                await owner.readConversationEvents(
                    fixture.botId,
                    created.conversationId,
                    accepted.eventCursor,
                    AbortSignal.timeout(5_000),
                ),
            ).toMatchObject({ events: [], hasMore: false });

            expect(
                await owner.createConversationConfigurationRevision(
                    created.conversationId,
                    {
                        additionalDirectoryIds: [],
                        booleanValue: false,
                        configId: "model",
                        idempotencyKey: "server-sdk-configure",
                        value: "codex-2",
                        valueType: "select",
                    },
                    AbortSignal.timeout(5_000),
                ),
            ).toMatchObject({ duplicate: false, requestId: "server-sdk-configure", status: "accepted" });
            expect(decodeSessionConfigureCommand(await fixture.socketMessages.next())).toMatchObject({
                configId: "model",
                requestId: "server-sdk-configure",
                sessionId: created.sessionId,
                value: "codex-2",
            });
        } finally {
            fixture.socket.close(1000, "Server SDK Conversation test complete");
        }
    });

    it("Given a Platform operator configures bounded Tenant capacity, When an App reaches that capacity, Then usage and audit APIs expose the enforced result", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(
                new DeveloperAuthenticator(),
                new Set(["developer-1"]),
                new Set([thirdPartyBrowserOrigin]),
            ),
        );
        const environment = bindings();
        const tenant = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                    body: JSON.stringify({
                        displayName: "Bounded tenant",
                        quotas: { activeApps: 1, activeProjects: 1, activeSessions: 1 },
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const tenantId = text(tenant, "tenantId");
        const [firstAppResponse, secondAppResponse] = await Promise.all([
            worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                    body: JSON.stringify({ displayName: "Bounded app", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                    body: JSON.stringify({ displayName: "Concurrent app", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
        ]);
        expect([firstAppResponse.status, secondAppResponse.status].sort()).toEqual([201, 429]);
        const createdAppResponse = firstAppResponse.status === 201 ? firstAppResponse : secondAppResponse;
        const appQuota = firstAppResponse.status === 429 ? firstAppResponse : secondAppResponse;
        const app = await json(createdAppResponse, 201);
        expect(
            await json(
                await worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${text(app, "appId")}`, {
                        headers: developerHeaders(),
                    }),
                    environment,
                ),
                200,
            ),
        ).toMatchObject({ appId: text(app, "appId"), tenantId });
        await expect(appQuota.json()).resolves.toMatchObject({ error: { code: "tenant_app_quota_exceeded" } });

        const appId = text(app, "appId");
        const [firstProjectResponse, secondProjectResponse] = await Promise.all([
            worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Only project",
                        idempotencyKey: "only-project",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Concurrent project",
                        idempotencyKey: "concurrent-project",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
        ]);
        expect([firstProjectResponse.status, secondProjectResponse.status].sort()).toEqual([201, 429]);
        const createdProjectResponse =
            firstProjectResponse.status === 201 ? firstProjectResponse : secondProjectResponse;
        const projectQuota = firstProjectResponse.status === 429 ? firstProjectResponse : secondProjectResponse;
        const project = await json(createdProjectResponse, 201);
        await expect(projectQuota.json()).resolves.toMatchObject({ error: { code: "tenant_project_quota_exceeded" } });

        const projectId = text(project, "projectId");
        const appCredential = text(record(app["defaultCredential"]), "credential");
        const runtimePairing = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: "bounded-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        installableAgents: [],
                        machineName: "Bounded Runtime",
                        pairingCode: text(runtimePairing, "pairingCode"),
                        workspaceName: "bounded-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        const createSession = async (sessionId: string): Promise<Response> =>
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${projectId}/sessions`, {
                    body: JSON.stringify({
                        agentId: "codex",
                        bindingId: "bounded-binding",
                        directoryId: "root",
                        policy: {
                            contentLimitBytes: 2_000_000,
                            hotEventLimit: 100,
                            idempotencyRetentionMilliseconds: 86_400_000,
                            level: "full",
                            retentionMilliseconds: 86_400_000,
                        },
                        runtimeId: text(runtimePairing, "runtimeId"),
                        sessionId,
                        title: sessionId,
                    }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            );
        expect((await createSession("bounded-session-1")).status).toBe(201);
        const sessionQuota = await createSession("bounded-session-2");
        expect(sessionQuota.status).toBe(429);
        await expect(sessionQuota.json()).resolves.toMatchObject({ error: { code: "session_quota_exceeded" } });

        const usage = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants/${tenantId}/usage`, {
                    headers: developerHeaders(),
                }),
                environment,
            ),
            200,
        );
        expect(usage).toMatchObject({ activeApps: 1, activeProjects: 1, activeSessions: 1 });
        const audit = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants/${tenantId}/audit-events`, {
                    headers: developerHeaders(),
                }),
                environment,
            ),
            200,
        );
        expect(audit["events"]).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ action: "app.created", outcome: "succeeded" }),
                expect.objectContaining({ action: "project.created", outcome: "succeeded" }),
                expect.objectContaining({ action: "quota.denied", outcome: "denied" }),
                expect.objectContaining({
                    action: "quota.denied",
                    details: { limit: 1, resource: "session" },
                    outcome: "denied",
                }),
            ]),
        );
    });

    it("Given an OIDC-authorized Platform developer, When one App provisions two Projects, Then its default AppCredential reaches both Projects and another App cannot reach either", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        const environment = bindings();
        const tenant = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                    body: JSON.stringify({ displayName: "Acme" }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const tenantId = text(tenant, "tenantId");
        const app = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                    body: JSON.stringify({ displayName: "Moxt", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const defaultCredential = text(record(app["defaultCredential"]), "credential");
        const projectOne = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Workspace One",
                        idempotencyKey: "workspace-one",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const projectTwo = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Workspace Two",
                        idempotencyKey: "workspace-two",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const projectOneId = text(projectOne, "projectId");
        const projectTwoId = text(projectTwo, "projectId");

        for (const projectId of [projectOneId, projectTwoId]) {
            const bots = await json(
                await worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                        headers: credentialHeaders(defaultCredential),
                    }),
                    environment,
                ),
                200,
            );
            expect(bots).toEqual({ bots: [] });
        }

        const otherApp = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                    body: JSON.stringify({ displayName: "Other", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const otherCredential = text(record(otherApp["defaultCredential"]), "credential");
        const denied = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectOneId}/bots`, {
                headers: credentialHeaders(otherCredential),
            }),
            environment,
        );
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ error: { code: "project_access_denied" } });
    });

    it("Given a non-expiring App key with one Project and read-only permission, When years pass and it is rotated and revoked, Then access persists while scope, permission, overlap, and revocation are enforced", async () => {
        const worker = createPlatformWorker(
            new PlatformAuthenticationConfiguration(new DeveloperAuthenticator(), new Set(["developer-1"])),
        );
        const environment = bindings();
        const tenant = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/tenants`, {
                    body: JSON.stringify({ displayName: "Credential Tenant" }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const app = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps`, {
                    body: JSON.stringify({ displayName: "Scoped App", tenantId: text(tenant, "tenantId") }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const appId = text(app, "appId");
        const firstProject = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "First",
                        idempotencyKey: "first",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const secondProject = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/projects`, {
                    body: JSON.stringify({
                        displayName: "Second",
                        idempotencyKey: "second",
                        locationHint: "apac",
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const issued = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/apps/${appId}/credentials`, {
                    body: JSON.stringify({
                        permissions: ["bot:read"],
                        projectIds: [text(firstProject, "projectId")],
                    }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const originalCredential = text(issued, "credential");
        const credentialId = text(issued, "credentialId");
        expect(issued).not.toHaveProperty("expiresAt");
        vi.setSystemTime(new Date("2036-09-14T00:00:00.000Z"));
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(firstProject, "projectId")}/bots`,
                        { headers: credentialHeaders(originalCredential) },
                    ),
                    environment,
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(secondProject, "projectId")}/bots`,
                        { headers: credentialHeaders(originalCredential) },
                    ),
                    environment,
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(firstProject, "projectId")}/bots`,
                        {
                            body: JSON.stringify({ avatarRef: "", description: "", displayName: "Denied" }),
                            headers: credentialHeaders(originalCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                )
            ).status,
        ).toBe(403);

        const rotated = await json(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/app-credentials/${credentialId}/rotate`, {
                    body: JSON.stringify({ overlapSeconds: 60 }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const replacementCredential = text(rotated, "credential");
        expect(rotated).not.toHaveProperty("expiresAt");
        vi.setSystemTime(new Date("2046-09-14T00:00:00.000Z"));
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(firstProject, "projectId")}/bots`,
                        { headers: credentialHeaders(originalCredential) },
                    ),
                    environment,
                )
            ).status,
        ).toBe(401);
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(firstProject, "projectId")}/bots`,
                        { headers: credentialHeaders(replacementCredential) },
                    ),
                    environment,
                )
            ).status,
        ).toBe(200);

        const replacementId = text(rotated, "credentialId");
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/platform/app-credentials/${replacementId}/revoke`,
                        { body: "{}", headers: developerHeaders(), method: "POST" },
                    ),
                    environment,
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${text(firstProject, "projectId")}/bots`,
                        { headers: credentialHeaders(replacementCredential) },
                    ),
                    environment,
                )
            ).status,
        ).toBe(401);
    });

    it("Given a ready Platform Conversation, When scoped actor credentials use fixed browser routes, Then targets, permissions, cursors, revocation, and accepted Turn lifetime stay isolated", async () => {
        const fixture = await createReadyConversation("browser-access");
        try {
            const issue = async (
                actorRef: string,
                conversationId: string,
                permissions: readonly string[],
                expiresInSeconds = 120,
            ) =>
                await json(
                    await fixture.worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/conversations/${conversationId}/access-credentials`,
                            {
                                body: JSON.stringify({
                                    actorRef,
                                    expiresInSeconds,
                                    permissions,
                                }),
                                headers: credentialHeaders(fixture.appCredential),
                                method: "POST",
                            },
                        ),
                        fixture.environment,
                    ),
                    201,
                );
            const fullPermissions = [
                "artifact:read",
                "artifact:write",
                "conversation:configure",
                "conversation:event:read",
                "conversation:message:create",
                "conversation:read",
                "conversation:turn:cancel",
                "conversation:turn:create",
            ];
            const alice = await issue("actor-alice", fixture.conversationId, fullPermissions);
            // Given wildcard browser access, unrelated origins still need a scoped credential and permission.
            const publicBrowserWorker = createPlatformWorker(
                new PlatformAuthenticationConfiguration(
                    new DeveloperAuthenticator(),
                    new Set(["developer-1"]),
                    new Set(["*"]),
                ),
            );
            const readOnly = await issue("public-browser", fixture.conversationId, ["conversation:read"]);
            for (const origin of ["https://independent-app.example", "https://another-app.example"]) {
                const endpoint = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`;
                const preflight = await publicBrowserWorker.fetch(
                    new Request(endpoint, {
                        method: "OPTIONS",
                        headers: {
                            origin,
                            "access-control-request-method": "GET",
                            "access-control-request-headers": "authorization",
                        },
                    }),
                    fixture.environment,
                );
                expect(preflight.status).toBe(204);
                expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
                const allowed = await publicBrowserWorker.fetch(
                    new Request(endpoint, {
                        headers: { origin, ...credentialHeaders(text(readOnly, "credential")) },
                    }),
                    fixture.environment,
                );
                expect(allowed.status).toBe(200);
                expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
                const unauthenticated = await publicBrowserWorker.fetch(
                    new Request(endpoint, { headers: { origin } }),
                    fixture.environment,
                );
                expect(unauthenticated.status).toBe(401);
                const deniedEvents = await publicBrowserWorker.fetch(
                    new Request(`${endpoint}/events`, {
                        headers: { origin, ...credentialHeaders(text(readOnly, "credential")) },
                    }),
                    fixture.environment,
                );
                expect(deniedEvents.status).toBe(403);
            }
            const aliceCredential = text(alice, "credential");
            const transport = new PlatformWorkerTransport(fixture.worker, fixture.environment);
            const platformApplication = new MobiusPlatformAppClient({
                credentialProvider: new MobiusAppCredentialProvider(fixture.appCredential),
                endpoint: relayOrigin,
                transport,
            });
            const sdkAccess = await platformApplication.issueConversationAccessCredential(
                fixture.conversationId,
                {
                    actorRef: "actor-sdk",
                    expiresInSeconds: 120,
                    permissions: fullPermissions,
                },
                AbortSignal.timeout(5_000),
            );
            const sdkBrowser = createMobiusConversationSession({
                accessTokenProvider: {
                    accessToken: async () => new MobiusBrowserAccessToken(sdkAccess.credential, sdkAccess.expiresAt),
                },
                endpoint: relayOrigin,
                transport,
            });
            const sdkSnapshot = await sdkBrowser.session.read(AbortSignal.timeout(5_000));
            expect(sdkSnapshot.access.actorRef).toBe("actor-sdk");
            expect(sdkSnapshot.session.sessionId).toBe(fixture.sessionId);
            expect("projects" in sdkBrowser).toBe(false);
            expect("runtimePairings" in sdkBrowser).toBe(false);
            expect("appCredentials" in sdkBrowser).toBe(false);

            const preflight = await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                    headers: {
                        "access-control-request-headers": "authorization",
                        "access-control-request-method": "GET",
                        origin: thirdPartyBrowserOrigin,
                    },
                    method: "OPTIONS",
                }),
                fixture.environment,
            );
            expect(preflight.status).toBe(204);
            expect(preflight.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
            expect(preflight.headers.get("access-control-expose-headers")?.split(", ")).toContain(
                "x-mobius-event-format",
            );
            const aliceSessionResponse = await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                    headers: { ...credentialHeaders(aliceCredential), origin: thirdPartyBrowserOrigin },
                }),
                fixture.environment,
            );
            expect(aliceSessionResponse.headers.get("access-control-allow-origin")).toBe(thirdPartyBrowserOrigin);
            const aliceSession = await json(aliceSessionResponse, 200);
            expect(record(aliceSession["access"])).toMatchObject({
                actorRef: "actor-alice",
                conversationId: fixture.conversationId,
            });
            expect(record(aliceSession["session"])).toMatchObject({ sessionId: fixture.sessionId });

            const deniedOrigin = await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                    headers: { ...credentialHeaders(aliceCredential), origin: "https://untrusted.example.test" },
                }),
                fixture.environment,
            );
            expect(deniedOrigin.status).toBe(403);
            await expect(deniedOrigin.json()).resolves.toMatchObject({ error: { code: "browser_origin_denied" } });

            const secondConversation = await json(
                await fixture.worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/bots/${fixture.botId}/conversations`,
                        {
                            body: JSON.stringify({ clientConversationKey: "conversation-browser-access-second" }),
                            headers: credentialHeaders(fixture.appCredential),
                            method: "POST",
                        },
                    ),
                    fixture.environment,
                ),
                201,
            );
            const bob = await issue("actor-bob", text(secondConversation, "conversationId"), ["conversation:read"]);
            const bobSession = await json(
                await fixture.worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                        headers: credentialHeaders(text(bob, "credential")),
                    }),
                    fixture.environment,
                ),
                200,
            );
            expect(record(bobSession["access"])).toMatchObject({
                actorRef: "actor-bob",
                conversationId: text(secondConversation, "conversationId"),
            });
            expect(record(bobSession["session"])).toMatchObject({ sessionId: text(secondConversation, "sessionId") });

            const forbiddenTarget = await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session?sessionId=${encodeURIComponent(text(secondConversation, "sessionId"))}`,
                    { headers: credentialHeaders(aliceCredential) },
                ),
                fixture.environment,
            );
            expect(forbiddenTarget.status).toBe(400);
            await expect(forbiddenTarget.json()).resolves.toMatchObject({
                error: { code: "browser_target_not_allowed" },
            });

            const controlPlane = await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${fixture.projectId}/bots`, {
                    headers: credentialHeaders(aliceCredential),
                }),
                fixture.environment,
            );
            expect(controlPlane.status).toBe(401);

            const readOnlyTurn = await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session/turns`, {
                    body: JSON.stringify({
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "denied",
                        idempotencyKey: "read-only-turn",
                        images: [],
                        resources: [],
                    }),
                    headers: credentialHeaders(text(bob, "credential")),
                    method: "POST",
                }),
                fixture.environment,
            );
            expect(readOnlyTurn.status).toBe(403);
            await expect(readOnlyTurn.json()).resolves.toMatchObject({
                error: { code: "conversation_permission_denied" },
            });

            const accepted = await json(
                await fixture.worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session/turns`, {
                        body: JSON.stringify({
                            additionalDirectoryIds: [],
                            artifactIds: [],
                            content: "hello from Alice",
                            idempotencyKey: "alice-turn",
                            images: [],
                            resources: [],
                        }),
                        headers: credentialHeaders(aliceCredential),
                        method: "POST",
                    }),
                    fixture.environment,
                ),
                202,
            );
            const command = decodeBotSessionPromptCommand(await fixture.socketMessages.next());
            expect(command).toMatchObject({
                botId: fixture.botId,
                commandId: "alice-turn",
                conversationId: fixture.conversationId,
                executionId: text(accepted, "executionId"),
                sessionId: fixture.sessionId,
                turnId: text(accepted, "turnId"),
            });
            await commitRuntimeEvent(
                fixture,
                attemptEvent(
                    fixture.sessionId,
                    command.commandId,
                    "alice-started",
                    SESSION_STARTED_KIND,
                    "attempt-alice",
                    1,
                ),
            );
            await commitRuntimeEvent(
                fixture,
                attemptEvent(
                    fixture.sessionId,
                    command.commandId,
                    "alice-completed",
                    SESSION_COMPLETED_KIND,
                    "attempt-alice",
                    2,
                ),
            );

            const firstEvents = await json(
                await fixture.worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session/events?limit=1`, {
                        headers: credentialHeaders(aliceCredential),
                    }),
                    fixture.environment,
                ),
                200,
            );
            expect(firstEvents["events"]).toMatchObject([{ eventId: "alice-started" }]);
            expect(firstEvents["hasMore"]).toBe(true);
            const resumedEvents = await json(
                await fixture.worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session/events?limit=10&cursor=${encodeURIComponent(text(firstEvents, "cursor"))}`,
                        { headers: credentialHeaders(aliceCredential) },
                    ),
                    fixture.environment,
                ),
                200,
            );
            expect(resumedEvents["events"]).toMatchObject([{ eventId: "alice-completed" }]);
            const sdkFirstEvents = await sdkBrowser.readEvents(
                new MobiusPageRequest(1, ""),
                AbortSignal.timeout(5_000),
            );
            expect(sdkFirstEvents.events.map((event) => event.eventId)).toEqual(["alice-started"]);
            const sdkResumedEvents = await sdkBrowser.readEvents(
                new MobiusPageRequest(10, sdkFirstEvents.cursor),
                AbortSignal.timeout(5_000),
            );
            expect(sdkResumedEvents.events.map((event) => event.eventId)).toEqual(["alice-completed"]);

            const rotated = await json(
                await fixture.worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/conversation-access-credentials/${text(alice, "credentialId")}/rotate`,
                        {
                            body: JSON.stringify({ expiresInSeconds: 60 }),
                            headers: credentialHeaders(fixture.appCredential),
                            method: "POST",
                        },
                    ),
                    fixture.environment,
                ),
                201,
            );
            expect(
                (
                    await fixture.worker.fetch(
                        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                            headers: credentialHeaders(aliceCredential),
                        }),
                        fixture.environment,
                    )
                ).status,
            ).toBe(401);
            expect(
                (
                    await fixture.worker.fetch(
                        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                            headers: credentialHeaders(text(rotated, "credential")),
                        }),
                        fixture.environment,
                    )
                ).status,
            ).toBe(200);

            vi.setSystemTime(Date.now() + 60_001);
            expect(
                (
                    await fixture.worker.fetch(
                        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                            headers: credentialHeaders(text(rotated, "credential")),
                        }),
                        fixture.environment,
                    )
                ).status,
            ).toBe(401);
            const durableTurn = await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/sessions/${fixture.sessionId}/turns/${text(accepted, "turnId")}`,
                    { headers: credentialHeaders(fixture.appCredential) },
                ),
                fixture.environment,
            );
            expect(durableTurn.status).toBe(200);

            const revoked = await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/conversation-access-credentials/${text(bob, "credentialId")}/revoke`,
                    { body: "{}", headers: credentialHeaders(fixture.appCredential), method: "POST" },
                ),
                fixture.environment,
            );
            expect(revoked.status).toBe(200);
            expect(
                (
                    await fixture.worker.fetch(
                        new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/client/session`, {
                            headers: credentialHeaders(text(bob, "credential")),
                        }),
                        fixture.environment,
                    )
                ).status,
            ).toBe(401);
            const liveSubscription = await sdkBrowser.events.subscribe(
                sdkResumedEvents.cursor,
                { receive: async () => true },
                AbortSignal.timeout(5_000),
            );
            const streamClosed = expect(liveSubscription.completed).rejects.toMatchObject({
                code: "conversation_credential_revoked",
            });
            const sdkRevocation = await platformApplication.revokeConversationAccessCredential(
                sdkAccess.credentialId,
                AbortSignal.timeout(5_000),
            );
            expect(sdkRevocation.credentialId).toBe(sdkAccess.credentialId);
            await streamClosed;
            await expect(sdkBrowser.session.read(AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(MobiusApiError);
            await expect(sdkBrowser.session.read(AbortSignal.timeout(5_000))).rejects.toMatchObject({
                code: "conversation_credential_revoked",
            });
            sdkBrowser.close();
        } finally {
            fixture.socket.close(1000, "Platform Conversation test complete");
        }
    });

    it("Given a ready Platform Conversation, When a browser configures it and persists a message before running it, Then the Runtime sees the pinned commands and history remains queryable", async () => {
        const fixture = await createReadyConversation("browser-history");
        try {
            const transport = new PlatformWorkerTransport(fixture.worker, fixture.environment);
            const application = new MobiusPlatformAppClient({
                credentialProvider: new MobiusAppCredentialProvider(fixture.appCredential),
                endpoint: relayOrigin,
                transport,
            });
            const issued = await application.issueConversationAccessCredential(
                fixture.conversationId,
                {
                    actorRef: "actor-browser-history",
                    expiresInSeconds: 120,
                    permissions: [
                        "artifact:read",
                        "conversation:configure",
                        "conversation:message:create",
                        "conversation:read",
                        "conversation:turn:create",
                    ],
                },
                AbortSignal.timeout(5_000),
            );
            let tokenRequests = 0;
            const browser = createMobiusConversationSession({
                accessTokenProvider: {
                    accessToken: async (signal) => {
                        tokenRequests += 1;
                        if (tokenRequests === 1) {
                            return new MobiusBrowserAccessToken(issued.credential, issued.expiresAt);
                        }
                        const refreshed = await application.issueConversationAccessCredential(
                            fixture.conversationId,
                            {
                                actorRef: "actor-browser-history",
                                expiresInSeconds: 120,
                                permissions: [
                                    "artifact:read",
                                    "conversation:configure",
                                    "conversation:message:create",
                                    "conversation:read",
                                    "conversation:turn:create",
                                ],
                            },
                            signal,
                        );
                        return new MobiusBrowserAccessToken(refreshed.credential, refreshed.expiresAt);
                    },
                },
                endpoint: relayOrigin,
                transport,
            });

            expect((await browser.configuration.read(AbortSignal.timeout(5_000))).revision).toBe(1);
            expect(
                await browser.configuration.update(
                    {
                        additionalDirectoryIds: [],
                        booleanValue: false,
                        configId: "model",
                        idempotencyKey: "browser-config-2",
                        value: "codex-2",
                        valueType: "select",
                    },
                    AbortSignal.timeout(5_000),
                ),
            ).toMatchObject({ duplicate: false, requestId: "browser-config-2", status: "accepted" });
            expect(decodeSessionConfigureCommand(await fixture.socketMessages.next())).toMatchObject({
                configId: "model",
                requestId: "browser-config-2",
                sessionId: fixture.sessionId,
                value: "codex-2",
            });
            await commitRuntimeEvent(fixture, {
                eventId: "browser-config-updated",
                kind: SESSION_EVENT_KIND,
                payload: encodeSessionConfigUpdatedEvent({
                    configOptions: [
                        {
                            booleanValue: false,
                            category: "model",
                            currentValue: "codex-2",
                            description: "Model used for this Session",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "Second model",
                                    groupId: "",
                                    groupName: "",
                                    name: "Codex 2",
                                    value: "codex-2",
                                },
                            ],
                        },
                    ],
                    kind: "session.config.updated",
                    requestId: "browser-config-2",
                    sessionId: fixture.sessionId,
                }),
                sessionId: fixture.sessionId,
                source: { kind: "runtime", sourceSeq: "1" },
            });
            expect(await browser.configuration.read(AbortSignal.timeout(5_000))).toMatchObject({
                options: [expect.objectContaining({ currentValue: "codex-2", id: "model" })],
                revision: 2,
            });

            const acceptedMessage = await browser.messages.create(
                {
                    artifactIds: [],
                    content: "persist this group message",
                    idempotencyKey: "browser-message-only",
                    images: [],
                    resources: [],
                },
                AbortSignal.timeout(5_000),
            );
            expect(acceptedMessage).toMatchObject({
                actorRef: "actor-browser-history",
                content: "persist this group message",
            });
            expect(await browser.history.read(new MobiusPageRequest(10, ""), AbortSignal.timeout(5_000))).toMatchObject(
                {
                    acceptedMessages: [expect.objectContaining({ messageId: acceptedMessage.messageId })],
                },
            );
            const turn = await browser.messages.run(acceptedMessage.messageId, AbortSignal.timeout(5_000));
            const command = decodeBotSessionPromptCommand(await fixture.socketMessages.next());
            expect(command).toMatchObject({
                bindingId: expect.any(String),
                commandId: acceptedMessage.messageId,
                prompt: "persist this group message",
            });
            expect(turn.turnId).toBe(command.turnId);
            expect(tokenRequests).toBe(1);
            vi.setSystemTime(Date.now() + 91_000);
            expect((await browser.session.read(AbortSignal.timeout(5_000))).session.sessionId).toBe(fixture.sessionId);
            expect(tokenRequests).toBe(2);
            browser.close();
        } finally {
            fixture.socket.close(1000, "Platform browser history test complete");
        }
    });

    it("Given one Platform Project already has a Runtime, When a backend pairs, polls, connects, and revokes another Runtime, Then each credential and status remains independent", async () => {
        const fixture = await provisionPlatformProject("multi-runtime");
        const secondRequest = new Request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/runtime-pairings`,
            {
                body: JSON.stringify({ idempotencyKey: "second-runtime" }),
                headers: credentialHeaders(fixture.appCredential),
                method: "POST",
            },
        );
        const second = await json(await fixture.worker.fetch(secondRequest.clone(), fixture.environment), 201);
        const replayed = await json(await fixture.worker.fetch(secondRequest, fixture.environment), 201);
        expect(replayed).toEqual(second);
        const pairingUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/runtime-pairings/${text(second, "pairingId")}`;
        expect(
            await json(
                await fixture.worker.fetch(
                    new Request(pairingUrl, { headers: credentialHeaders(fixture.appCredential) }),
                    fixture.environment,
                ),
                200,
            ),
        ).toMatchObject({ status: "pending" });
        const claimed = await json(
            await fixture.worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        installableAgents: [],
                        machineName: "Second Runtime",
                        pairingCode: text(second, "pairingCode"),
                        workspaceName: "second-runtime",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                fixture.environment,
            ),
            200,
        );
        expect(text(claimed, "daemonToken")).not.toBe(fixture.daemonToken);
        expect(
            await json(
                await fixture.worker.fetch(
                    new Request(pairingUrl, { headers: credentialHeaders(fixture.appCredential) }),
                    fixture.environment,
                ),
                200,
            ),
        ).toMatchObject({ status: "paired", runtimeId: text(second, "runtimeId") });

        const server = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(fixture.appCredential),
            endpoint: relayOrigin,
            projectId: fixture.projectId,
            transport: new PlatformWorkerTransport(fixture.worker, fixture.environment),
        });
        const paired = await server.runtimePairings.waitUntilPaired(
            text(second, "pairingId"),
            new MobiusRuntimePairingWaitOptions(5_000, 100),
            AbortSignal.timeout(5_000),
        );
        expect(paired.runtimeId).toBe(text(second, "runtimeId"));
        server.close();

        const daemonResponse = await fixture.worker.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${text(second, "channelId")}/daemon?token=${text(claimed, "daemonToken")}`,
                { headers: { Upgrade: "websocket" } },
            ),
            fixture.environment,
        );
        expect(daemonResponse.status).toBe(101);
        const socket = daemonResponse.webSocket;
        if (socket === null) {
            throw new Error("Expected the second Runtime WebSocket");
        }
        socket.accept();
        try {
            const runtimes = await json(
                await fixture.worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/runtimes`, {
                        headers: credentialHeaders(fixture.appCredential),
                    }),
                    fixture.environment,
                ),
                200,
            );
            expect(runtimes["runtimes"]).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ online: false, runtimeId: fixture.runtimeId }),
                    expect.objectContaining({ online: true, runtimeId: text(second, "runtimeId") }),
                ]),
            );
            const revoked = await fixture.worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/runtimes/${fixture.runtimeId}`,
                    { headers: credentialHeaders(fixture.appCredential), method: "DELETE" },
                ),
                fixture.environment,
            );
            expect(revoked.status).toBe(204);
            const surviving = await json(
                await fixture.worker.fetch(
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${fixture.projectId}/runtimes`, {
                        headers: credentialHeaders(fixture.appCredential),
                    }),
                    fixture.environment,
                ),
                200,
            );
            expect(surviving["runtimes"]).toMatchObject([
                expect.objectContaining({ online: true, runtimeId: text(second, "runtimeId") }),
            ]);
        } finally {
            socket.close(1000, "Platform multi-Runtime test complete");
        }
    });
});
