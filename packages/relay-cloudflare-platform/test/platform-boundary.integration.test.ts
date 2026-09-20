import { env } from "cloudflare:workers";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
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
});
