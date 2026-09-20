import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeServiceToDaemonMessage,
    encodeDaemonToServiceMessage,
    MOBIUS_API_PREFIX,
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
    it("Given a non-retained Session has hibernated, When its Runtime connects, Then the WebSocket opens before live history is restored", async () => {
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
        await runInDurableObject(sessionStub, async (instance, state) => {
            if (instance.alarm === undefined) {
                throw new Error("Expected the non-retained Session alarm handler");
            }
            await state.storage.deleteAlarm();
            await instance.alarm();
        });

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
            const load = decodeServiceToDaemonMessage(await messages.next());
            expect(load).toMatchObject({ kind: "session.live-history.load", sessionId });
            if (load.kind !== "session.live-history.load") {
                throw new Error("Expected the live-history request");
            }
            socket.send(
                encodeDaemonToServiceMessage({
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                        messages: [],
                        status: "available",
                        truncated: false,
                    },
                    kind: "session.live-history.loaded",
                    requestId: load.requestId,
                    sessionId,
                }),
            );
            expect(decodeServiceToDaemonMessage(await messages.next())).toEqual({
                kind: "runtime.liveness.ready",
            });
        } finally {
            socket.close(1000, "Private reconnect test complete");
        }
    });
});
