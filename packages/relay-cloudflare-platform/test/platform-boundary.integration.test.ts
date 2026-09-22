import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeServiceToDaemonMessage,
    decodeSessionPromptCommand,
    encodeDaemonToServiceMessage,
    encodeSessionEventEnvelope,
    MOBIUS_API_PREFIX,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_FAILED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_STARTED_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusPlatformApp } from "../../../tests/infra/app.ts";
import { FakeClerk } from "../../../tests/infra/clerk.ts";
import {
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";

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
        NON_CLOUD_RETENTION_SESSION_RELAY: env.NON_CLOUD_RETENTION_SESSION_RELAY,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
        SESSION_RELAY: env.SESSION_RELAY,
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
    return new Headers({ authorization: `Bearer ${credential}`, "content-type": "application/json" });
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

    it("Given an App disables cloud retention, When its owner creates and updates the App, Then Platform exposes the policy for future Sessions", async () => {
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
        const created = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                    body: JSON.stringify({ displayName: "Private sessions", cloudRetention: false, tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        expect(created["cloudRetention"]).toBe(false);

        const updated = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(created, "appId")}`, {
                    body: JSON.stringify({ displayName: "Durable sessions", cloudRetention: true }),
                    headers: developerHeaders(),
                    method: "PUT",
                }),
                environment,
            ),
            200,
        );
        expect(updated["cloudRetention"]).toBe(true);
    });

    it("Given an existing Platform Project has a Session, When an operator runs the cloud-retention migration, Then the Project and Session stores are migrated", async () => {
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
                    body: JSON.stringify({ displayName: "Migration App", tenantId }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );
        const project = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                    body: JSON.stringify({
                        clientReference: "migration-project",
                        displayName: "Migration Project",
                        idempotencyKey: "migration-project",
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
        const sessionId = "migration-session";
        const runtimeId = "migration-runtime";
        const insert = await environment.PROJECT_RELAY.getByName(projectId).fetch(
            `https://project.internal/mobius/internal/projects/${encodeURIComponent(projectId)}/database`,
            {
                body: JSON.stringify({
                    kind: "run",
                    statement: {
                        sql: `INSERT INTO session_directory (
                            project_id, session_id, runtime_id, lifecycle, updated_at, summary_json
                        ) VALUES (?, ?, ?, 'ready', ?, ?)`,
                        values: [
                            projectId,
                            sessionId,
                            runtimeId,
                            Date.now(),
                            JSON.stringify({ projectId, runtimeId, sessionId }),
                        ],
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(insert.status).toBe(200);

        const beforeStatus = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/migrations/cloud-retention`, {
                    headers: developerHeaders(),
                }),
                environment,
            ),
            200,
        );
        expect(beforeStatus).toMatchObject({
            complete: false,
            completedProjects: 0,
            nextIncompleteProjectId: projectId,
            totalProjects: 1,
        });

        const firstPage = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/migrations/cloud-retention`, {
                    body: JSON.stringify({ cursor: { kind: "projects", afterProjectId: "" } }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        expect(firstPage).toMatchObject({
            cursor: { kind: "projects", afterProjectId: projectId },
            migratedProjectId: projectId,
            migratedSessions: 1,
            state: "in_progress",
        });

        const completion = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/migrations/cloud-retention`, {
                    body: JSON.stringify({ cursor: { kind: "projects", afterProjectId: projectId } }),
                    headers: developerHeaders(),
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        expect(completion).toMatchObject({ completedProjects: 1, state: "complete", totalProjects: 1 });

        const sessionMigration = await environment.PROJECT_RELAY.getByName(projectId).fetch(
            `https://project.internal/mobius/internal/projects/${encodeURIComponent(projectId)}/database`,
            {
                body: JSON.stringify({
                    kind: "all",
                    statement: {
                        sql: "SELECT cloud_retention FROM session_directory WHERE session_id = ?",
                        values: [sessionId],
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(sessionMigration.status).toBe(200);
        expect((await sessionMigration.json()) as unknown).toMatchObject({
            results: [{ cloud_retention: 1 }],
        });
    });

    it("Given a Session-only Platform Relay, When a client reaches a retired Bot endpoint, Then the endpoint is unavailable", async () => {
        const worker = createTestMobiusPlatformApp(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set()),
            createPlatformGateways,
        );

        const response = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connection-grants/redeem`, { method: "POST" }),
            bindings(),
        );

        expect(response.status).toBe(404);
    });
    it("Given a non-retained Session has hibernated, When it resumes, Then delivery remains contiguous and history comes from its Runtime", async () => {
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
                    body: JSON.stringify({ displayName: "Private reconnect", cloudRetention: false, tenantId }),
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
        const runtimeId = text(claimed, "runtimeId");
        const sessionId = "private-reconnect-session";
        await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions`, {
                    body: JSON.stringify({
                        agentId: "codex",
                        bindingId: "workspace",
                        directoryId: "root",
                        policy: {
                            contentLimitBytes: 2_000_000,
                            hotEventLimit: 100,
                            idempotencyRetentionMilliseconds: 86_400_000,
                            level: "full",
                            retentionMilliseconds: 86_400_000,
                        },
                        runtimeId,
                        sessionId,
                        title: "Private reconnect Session",
                    }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
                environment,
            ),
            201,
        );

        const sessionStub = environment.NON_CLOUD_RETENTION_SESSION_RELAY.getByName(
            `platform:${projectId}:${sessionId}`,
        );
        const response = await worker.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?deliveryReceipts=1&liveness=1`, {
                headers: {
                    authorization: `Bearer ${text(claimed, "runtimeCredential")}`,
                    Upgrade: "websocket",
                },
            }),
            environment,
        );
        expect(response.status).toBe(101);
        if (response.webSocket === null) {
            throw new Error("Expected the Runtime WebSocket");
        }
        const socket = response.webSocket;
        const messages = new SocketMessages(socket);
        socket.accept();
        try {
            expect(decodeServiceToDaemonMessage(await messages.next())).toEqual({
                kind: "runtime.liveness.ready",
            });

            const turnRequest = {
                additionalDirectoryIds: [],
                artifactIds: [],
                content: "private prompt must be scrubbed",
                idempotencyKey: "private-reconnect-turn",
                images: [
                    {
                        data: "cHJpdmF0ZSBpbWFnZSBtdXN0IGJlIHNjcnViYmVk",
                        mimeType: "image/png",
                        name: "private.png",
                    },
                ],
                resources: [
                    {
                        mimeType: "text/plain",
                        name: "private.txt",
                        text: "private resource must be scrubbed",
                        type: "embedded",
                        uri: "file:///private.txt",
                    },
                ],
                sessionConfigurations: [
                    {
                        booleanValue: false,
                        configId: "model",
                        value: "gpt-5.6-terra",
                        valueType: "select",
                    },
                ],
            };
            const acceptedTurn = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                        {
                            body: JSON.stringify(turnRequest),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                202,
            );
            const turnId = text(acceptedTurn, "turnId");
            const delivery = decodeServiceToDaemonMessage(await messages.next());
            if (delivery.kind !== RUNTIME_DELIVERY_KIND) {
                throw new Error("Expected the private Session prompt delivery");
            }
            socket.send(
                encodeDaemonToServiceMessage({
                    deliveryId: delivery.deliveryId,
                    kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                    sessionId,
                }),
            );
            expect(decodeServiceToDaemonMessage(await messages.next())).toMatchObject({
                deliveryId: delivery.deliveryId,
                kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                sessionId,
            });
            const command = decodeSessionPromptCommand(delivery.payload);
            const attemptId = "private-reconnect-attempt";
            for (const [eventIndex, event] of [
                {
                    attemptId,
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                },
                {
                    commandId: command.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId: "private-reconnect-message",
                    sessionId,
                    text: "private response must be scrubbed",
                },
                {
                    commandId: command.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                },
            ].entries()) {
                socket.send(
                    encodeSessionEventEnvelope({
                        eventId: `private-reconnect-${event.kind}`,
                        kind: "session.event",
                        payload: JSON.stringify(event),
                        sessionId,
                        source: { attemptId, kind: "attempt", sourceSeq: (eventIndex + 1).toString() },
                    }),
                );
                expect(decodeServiceToDaemonMessage(await messages.next())).toMatchObject({
                    eventId: `private-reconnect-${event.kind}`,
                    kind: SESSION_EVENT_ACK_KIND,
                    sessionId,
                });
            }

            const readResource = async (path: string) =>
                responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/${path}`,
                            { headers: credentialHeaders(appCredential) },
                        ),
                        environment,
                    ),
                    200,
                );
            const additionalTurns = new Map<
                string,
                { readonly turnId: string; readonly attemptId: string; readonly commandId: string }
            >();
            for (const outcome of ["failed", "running", "steering"]) {
                const accepted = await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                            {
                                body: JSON.stringify({
                                    ...turnRequest,
                                    content: `private ${outcome} prompt`,
                                    idempotencyKey: `private-${outcome}-turn`,
                                    ...(outcome === "steering"
                                        ? {
                                              disposition: "steer",
                                              targetCommandId: additionalTurns.get("running")?.commandId,
                                          }
                                        : {}),
                                }),
                                headers: credentialHeaders(appCredential),
                                method: "POST",
                            },
                        ),
                        environment,
                    ),
                    202,
                );
                const delivered = decodeServiceToDaemonMessage(await messages.next());
                if (delivered.kind !== RUNTIME_DELIVERY_KIND) {
                    throw new Error("Expected the additional private Session prompt delivery");
                }
                socket.send(
                    encodeDaemonToServiceMessage({
                        deliveryId: delivered.deliveryId,
                        kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                        sessionId,
                    }),
                );
                expect(decodeServiceToDaemonMessage(await messages.next())).toMatchObject({
                    deliveryId: delivered.deliveryId,
                    kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                });
                const deliveredCommand = decodeSessionPromptCommand(delivered.payload);
                const additionalAttemptId = `private-${outcome}-attempt`;
                const events = [
                    {
                        attemptId: additionalAttemptId,
                        commandId: deliveredCommand.commandId,
                        kind: SESSION_STARTED_KIND,
                        sessionId,
                    },
                    ...(outcome === "failed"
                        ? [
                              {
                                  code: "agent_failed",
                                  commandId: deliveredCommand.commandId,
                                  kind: SESSION_FAILED_KIND,
                                  message: "private error must be scrubbed",
                                  sessionId,
                              },
                          ]
                        : outcome === "steering"
                          ? [
                                {
                                    commandId: deliveredCommand.commandId,
                                    kind: SESSION_COMPLETED_KIND,
                                    sessionId,
                                    stopReason: "end_turn",
                                },
                            ]
                          : []),
                ];
                for (const [eventIndex, event] of events.entries()) {
                    const eventId = `private-${outcome}-${eventIndex}`;
                    socket.send(
                        encodeSessionEventEnvelope({
                            eventId,
                            kind: "session.event",
                            payload: JSON.stringify(event),
                            sessionId,
                            source: {
                                attemptId: additionalAttemptId,
                                kind: "attempt",
                                sourceSeq: (eventIndex + 1).toString(),
                            },
                        }),
                    );
                    expect(decodeServiceToDaemonMessage(await messages.next())).toMatchObject({
                        eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                    });
                }
                const additionalTurnId = text(accepted, "turnId");
                additionalTurns.set(outcome, {
                    turnId: additionalTurnId,
                    attemptId: additionalAttemptId,
                    commandId: deliveredCommand.commandId,
                });
                expect(await readResource(`turns/${additionalTurnId}`)).toMatchObject({
                    request: { content: `private ${outcome} prompt`, kind: "prompt" },
                    state: { kind: outcome === "steering" ? "succeeded" : outcome },
                });
                if (outcome === "failed") {
                    expect(await readResource(`attempts/${additionalAttemptId}`)).toMatchObject({
                        state: { error: { message: "private error must be scrubbed" }, kind: "failed" },
                    });
                }
            }

            socket.send(
                encodeSessionEventEnvelope({
                    eventId: "private-reconnect-before-eviction",
                    kind: "session.event",
                    payload: JSON.stringify({
                        kind: SESSION_INFO_UPDATED_KIND,
                        sessionId,
                        title: "private content must be scrubbed",
                        updatedAt: "2030-01-01T00:00:00.000Z",
                    }),
                    sessionId,
                    source: { kind: "runtime", sourceSeq: "1" },
                }),
            );
            const beforeEviction = decodeServiceToDaemonMessage(await messages.next());
            expect(beforeEviction).toMatchObject({
                eventId: "private-reconnect-before-eviction",
                kind: SESSION_EVENT_ACK_KIND,
                sessionId,
            });

            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the non-retained Session alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
            });
            expect(await readResource(`turns/${turnId}`)).toMatchObject({
                request: { content: turnRequest.content, kind: "prompt" },
                state: { kind: "succeeded" },
            });
            vi.setSystemTime(new Date("2030-01-01T00:05:00.000Z"));
            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the non-retained Session alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
            });
            await evictDurableObject(sessionStub);

            const scrubbedTurnResponse = await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns/${turnId}`,
                    { headers: credentialHeaders(appCredential) },
                ),
                environment,
            );
            const scrubbedTurn = await responseJson(scrubbedTurnResponse, 200);
            expect(scrubbedTurn).toMatchObject({
                request: { kind: "not_retained" },
                state: { kind: "succeeded" },
                turnId,
            });
            expect(JSON.stringify(scrubbedTurn)).not.toContain("private prompt");
            expect(JSON.stringify(scrubbedTurn)).not.toContain("private resource");
            expect(JSON.stringify(scrubbedTurn)).not.toContain("private response");
            expect(JSON.stringify(scrubbedTurn)).not.toContain("cHJpdmF0ZSBpbWFnZSBtdXN0IGJlIHNjcnViYmVk");

            expect(scrubbedTurn["request"]).toEqual({ kind: "not_retained" });
            for (const [outcome, resource] of additionalTurns) {
                const turn = await readResource(`turns/${resource.turnId}`);
                expect(turn).toMatchObject({
                    state: { kind: outcome === "steering" ? "succeeded" : outcome },
                    turnId: resource.turnId,
                });
                if (outcome === "failed") {
                    expect(turn["request"]).toEqual({ kind: "not_retained" });
                    const attempt = await readResource(`attempts/${resource.attemptId}`);
                    expect(attempt).toMatchObject({
                        attemptId: resource.attemptId,
                        state: { error: { code: "agent_failed" }, kind: "failed" },
                    });
                    expect(JSON.stringify({ turn, attempt })).not.toContain("private error");
                    const retriedFailure = await responseJson(
                        await worker.fetch(
                            new Request(
                                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                                {
                                    body: JSON.stringify({
                                        ...turnRequest,
                                        content: "private failed prompt",
                                        idempotencyKey: "private-failed-turn",
                                    }),
                                    headers: credentialHeaders(appCredential),
                                    method: "POST",
                                },
                            ),
                            environment,
                        ),
                        202,
                    );
                    expect(retriedFailure).toEqual(turn);
                } else if (outcome === "steering") {
                    expect(turn["request"]).toEqual({ kind: "not_retained" });
                } else {
                    expect(turn["request"]).toMatchObject({ content: "private running prompt", kind: "prompt" });
                }
            }
            const retriedTurn = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                        {
                            body: JSON.stringify(turnRequest),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                202,
            );
            expect(retriedTurn).toEqual(scrubbedTurn);
            vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the non-retained Session alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
            });
            expect(await readResource(`turns/${turnId}`)).toEqual(scrubbedTurn);

            for (const [outcome, resource] of additionalTurns) {
                const turn = await readResource(`turns/${resource.turnId}`);
                expect(turn).toMatchObject({
                    state: { kind: outcome === "steering" ? "succeeded" : outcome },
                    turnId: resource.turnId,
                });
                expect(turn["request"]).toMatchObject(
                    outcome !== "running"
                        ? { kind: "not_retained" }
                        : { content: "private running prompt", kind: "prompt" },
                );
            }
            const queuedAfterScrub = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/turns`,
                        {
                            body: JSON.stringify({
                                ...turnRequest,
                                content: "Queue after a completed steering Turn was scrubbed",
                                disposition: "queue",
                                idempotencyKey: "private-queue-after-scrub",
                                targetCommandId: additionalTurns.get("running")?.commandId,
                            }),
                            headers: credentialHeaders(appCredential),
                            method: "POST",
                        },
                    ),
                    environment,
                ),
                202,
            );
            expect(queuedAfterScrub).toMatchObject({ state: { kind: "queued" } });
            // Recreate the invalid command JSON written by the former retention cleanup.
            // This persistence fixture belongs to upgrade recovery; all Turn creation used the public API.
            await runInDurableObject(sessionStub, async (_instance, state) => {
                state.storage.sql.exec(
                    "UPDATE turns SET command_json = ? WHERE turn_id = ?",
                    JSON.stringify({ ...command, prompt: "", images: [], resources: [] }),
                    turnId,
                );
            });
            await evictDurableObject(sessionStub);
            expect(await readResource(`turns/${turnId}`)).toEqual(scrubbedTurn);
            expect(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/export`,
                            { headers: credentialHeaders(appCredential) },
                        ),
                        environment,
                    ),
                    409,
                ),
            ).toMatchObject({ error: { code: "session_history_not_retained" } });

            socket.send(
                encodeSessionEventEnvelope({
                    eventId: "private-reconnect-after-eviction",
                    kind: "session.event",
                    payload: JSON.stringify({
                        kind: SESSION_INFO_UPDATED_KIND,
                        sessionId,
                        title: "After eviction",
                        updatedAt: "2030-01-01T00:00:01.000Z",
                    }),
                    sessionId,
                    source: { kind: "runtime", sourceSeq: "2" },
                }),
            );
            const committed = decodeServiceToDaemonMessage(await messages.next());
            expect(committed).toMatchObject({
                eventId: "private-reconnect-after-eviction",
                kind: SESSION_EVENT_ACK_KIND,
                sessionId,
            });

            const retainedMessagesResponse = await worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/messages`,
                    { headers: credentialHeaders(appCredential) },
                ),
                environment,
            );
            expect(await responseJson(retainedMessagesResponse, 409)).toEqual({
                error: {
                    code: "session_history_not_retained",
                    message: "This Session does not retain Platform message history",
                },
            });

            const nativeHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/native-messages?limit=2`,
                    { headers: credentialHeaders(appCredential) },
                ),
                environment,
            );
            const load = decodeServiceToDaemonMessage(await messages.next());
            expect(load).toMatchObject({ kind: "session.live-history.load", sessionId });
            if (load.kind !== "session.live-history.load") {
                throw new Error("Expected the live-history request");
            }
            socket.send(
                encodeDaemonToServiceMessage({
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: ["daemon-message:agent"],
                        messages: [
                            {
                                activities: [],
                                content: [],
                                role: "assistant",
                                text: "Oldest daemon history",
                            },
                            {
                                role: "user",
                                text: "Recent daemon prompt",
                            },
                            {
                                activities: [
                                    {
                                        activityId: "reasoning-1",
                                        activityType: "reasoning",
                                        content: [],
                                        input: "",
                                        locations: [],
                                        name: "",
                                        output: "Inspecting the workspace",
                                        sequence: 0,
                                        status: "completed",
                                        title: "Reasoning",
                                        toolKind: "think",
                                    },
                                    {
                                        activityId: "tool-1",
                                        activityType: "tool",
                                        content: [],
                                        input: '{"path":"package.json"}',
                                        locations: ["/workspace/package.json"],
                                        name: "read_file",
                                        output: '{"name":"workspace"}',
                                        sequence: 1,
                                        status: "completed",
                                        title: "Read package metadata",
                                        toolKind: "read",
                                    },
                                    {
                                        activityId: "error-1",
                                        activityType: "tool",
                                        content: [],
                                        input: "{}",
                                        locations: [],
                                        name: "agent_error",
                                        output: "Agent could not inspect the optional workspace file",
                                        sequence: 2,
                                        status: "failed",
                                        title: "Agent error",
                                        toolKind: "other",
                                    },
                                ],
                                content: [],
                                role: "assistant",
                                text: "History owned by the daemon",
                            },
                        ],
                        status: "available",
                        truncated: false,
                    },
                    kind: "session.live-history.loaded",
                    requestId: load.requestId,
                    sessionId,
                }),
            );
            const firstPage = await responseJson(await nativeHistoryResponse, 200);
            expect(firstPage).toMatchObject({
                messages: [
                    { role: "user", text: "Recent daemon prompt" },
                    {
                        activities: expect.arrayContaining([
                            expect.objectContaining({ activityType: "reasoning", output: "Inspecting the workspace" }),
                            expect.objectContaining({ activityType: "tool", title: "Read package metadata" }),
                            expect.objectContaining({
                                activityType: "tool",
                                output: "Agent could not inspect the optional workspace file",
                                status: "failed",
                                title: "Agent error",
                            }),
                        ]),
                        role: "assistant",
                        text: "History owned by the daemon",
                    },
                ],
                status: "available",
            });
            expect(firstPage).toHaveProperty("nextCursor", expect.any(String));

            const olderHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/sessions/${sessionId}/native-messages?limit=2&cursor=${encodeURIComponent(String(firstPage["nextCursor"]))}`,
                    { headers: credentialHeaders(appCredential) },
                ),
                environment,
            );
            const olderLoad = decodeServiceToDaemonMessage(await messages.next());
            expect(olderLoad).toMatchObject({ kind: "session.live-history.load", sessionId });
            if (olderLoad.kind !== "session.live-history.load") {
                throw new Error("Expected the older live-history request");
            }
            socket.send(
                encodeDaemonToServiceMessage({
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: ["daemon-message:agent"],
                        messages: [
                            { activities: [], content: [], role: "assistant", text: "Oldest daemon history" },
                            { role: "user", text: "Recent daemon prompt" },
                            { activities: [], content: [], role: "assistant", text: "History owned by the daemon" },
                        ],
                        status: "available",
                        truncated: false,
                    },
                    kind: "session.live-history.loaded",
                    requestId: olderLoad.requestId,
                    sessionId,
                }),
            );
            expect(await responseJson(await olderHistoryResponse, 200)).toMatchObject({
                messages: [{ role: "assistant", text: "Oldest daemon history" }],
                nextCursor: null,
                status: "available",
            });
        } finally {
            socket.close(1000, "Private reconnect test complete");
        }
    });
});
