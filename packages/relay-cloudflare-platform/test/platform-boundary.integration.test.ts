import { env } from "cloudflare:workers";
import {
    BotExecutionBindingApprovedEvent,
    decodeBotExecutionBindingApprovalRequest,
    decodeBotSessionPromptCommand,
    decodeSessionConfigureCommand,
    decodeSessionEventAcknowledgement,
    encodeBotExecutionBindingApprovedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionEventEnvelope,
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
                    placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bots/${botId}/behavior-revisions`, {
                body: JSON.stringify({
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "Answer from the approved local Runtime.",
                    requiredCapabilities: ["embedded-context"],
                }),
                headers: credentialHeaders(project.appCredential),
                method: "POST",
            }),
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
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bots/${botId}/execution-bindings`, {
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
            }),
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
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bots/${botId}/conversations`, {
                body: JSON.stringify({ clientConversationKey: `conversation-${label}` }),
                headers: credentialHeaders(project.appCredential),
                method: "POST",
            }),
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

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Platform hosting boundary", () => {
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
            ["/v1/apps/app-test/credentials", { expiresInSeconds: 10, permissions: [], projectIds: [12] }],
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
            placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                expiresInSeconds: 3_600,
                permissions: ["bot:read", "conversation:read"],
                projectIds: [project.projectId],
            },
            AbortSignal.timeout(5_000),
        );
        const rotated = await developer.rotateAppCredential(scoped.credentialId, 3_600, 60, AbortSignal.timeout(5_000));
        expect(rotated.replacedCredentialId).toBe(scoped.credentialId);
        expect(
            (await developer.revokeAppCredential(rotated.credentialId, AbortSignal.timeout(5_000))).credentialId,
        ).toBe(rotated.credentialId);
        service.close();
    });

    it("Given an approved Project Bot, When the server SDK creates and operates a Conversation, Then the exact Conversation routes persist it and dispatch configuration and Turn commands", async () => {
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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

    it("Given an AppCredential with one Project and read-only permission, When it is used, rotated, and revoked, Then scope, permission, overlap, and revocation are enforced", async () => {
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                        placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
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
                        expiresInSeconds: 3600,
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
                    body: JSON.stringify({ expiresInSeconds: 3600, overlapSeconds: 60 }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const replacementCredential = text(rotated, "credential");
        vi.setSystemTime(Date.now() + 60_001);
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
                    new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bots/${fixture.botId}/conversations`, {
                        body: JSON.stringify({ clientConversationKey: "conversation-browser-access-second" }),
                        headers: credentialHeaders(fixture.appCredential),
                        method: "POST",
                    }),
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
