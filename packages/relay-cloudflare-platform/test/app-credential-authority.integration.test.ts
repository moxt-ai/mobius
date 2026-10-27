import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectDatabaseAdapter } from "@moxt-ai/mobius-relay-core";
import { StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";
import { MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { RuntimeRelay } from "../src/durable-objects/runtime-relay.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";

const origin = `https://platform.test${MOBIUS_API_PREFIX}`;
const clerk = new FakeClerk();
const credentialResource = v.object({ credential: v.string(), credentialId: v.string() });

async function responseJson(response: Response, status: number): Promise<unknown> {
    const body: unknown = await response.json();
    expect(response.status).toBe(status);
    return body;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
    clerk.reset();
});

afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

async function application() {
    const worker = createTestMobiusPlatformApp(
        new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
        createPlatformGateways,
    );
    const developerHeaders = {
        authorization: `Bearer ${clerk.session("developer-1", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    };
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: origin,
        authenticationProviderId: "clerk",
        credentialProvider: new StaticMobiusCredentialProvider(
            clerk.session("developer-1", clerk.defaultOrganizationId),
        ),
        transport: { fetch: async (request) => await worker.fetch(request, env) },
    });
    const dashboard = async (path: string, body?: object) =>
        await worker.fetch(
            new Request(`${origin}/dashboard/v1/${path}`, {
                headers: developerHeaders,
                ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
            }),
            env,
        );
    const { tenants } = v.parse(
        v.object({ tenants: v.array(v.object({ tenantId: v.string() })) }),
        await responseJson(await dashboard("platform/tenants"), 200),
    );
    const tenant = tenants[0];
    if (tenant === undefined) {
        throw new Error("Expected a developer Tenant");
    }
    const { appId, defaultCredential } = v.parse(
        v.object({ appId: v.string(), defaultCredential: credentialResource }),
        await responseJson(
            await dashboard("apps", { displayName: "Credential authority", tenantId: tenant.tenantId }),
            201,
        ),
    );
    const { projectId } = v.parse(
        v.object({ projectId: v.string() }),
        await responseJson(
            await dashboard(`apps/${appId}/projects`, {
                displayName: "Credential authority Project",
                idempotencyKey: "credential-authority-project",
                locationHint: "apac",
            }),
            201,
        ),
    );
    const sessionId = "credential-authority-session";
    const runtimeId = "credential-authority-runtime";
    const sessionRequest = async (
        path: string,
        credential: string,
        body?: object,
        directory = env.PLATFORM_DIRECTORY_DATABASE,
    ) =>
        await runInDurableObject(
            env.PROJECT_RELAY.getByName(projectId),
            async (_instance, state) =>
                await worker.fetch(
                    new Request(`${origin}/v1/projects/${projectId}/sessions/${sessionId}/${path}`, {
                        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
                        ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
                    }),
                    {
                        ...env,
                        MOBIUS_PROJECT_DATABASE: new DurableObjectDatabaseAdapter(state.storage),
                        MOBIUS_PROJECT_ID: projectId,
                        PLATFORM_DIRECTORY_DATABASE: directory,
                    },
                ),
        );
    const authenticateApp = async (
        credential = defaultCredential.credential,
        directory = env.PLATFORM_DIRECTORY_DATABASE,
    ) => await sessionRequest("access-credentials", credential, { expiresInSeconds: 900, runtimeId }, directory);
    const session = v.parse(v.object({ credential: v.string() }), await responseJson(await authenticateApp(), 201));

    // Capture the pre-change record, then publish it after the mutation to model a late KV fill.
    const snapshot = await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `SELECT credentials.*, apps.tenant_id, apps.lifecycle AS app_lifecycle,
                tenants.lifecycle AS tenant_lifecycle
           FROM platform_app_credentials AS credentials
           JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
           JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
          WHERE credentials.credential_id = ?`,
    )
        .bind(defaultCredential.credentialId)
        .first();
    const keys = v.parse(v.object({ secret_digest: v.string(), public_credential_id: v.string() }), snapshot);
    const validatedAt = Date.now();
    const legacyCacheRecord = JSON.stringify({
        version: 1,
        validatedAt,
        expiresAt: validatedAt + 2 * 60 * 60 * 1_000,
        credential: snapshot,
    });

    return {
        appId,
        projectId,
        defaultCredential,
        listCredentials: async () => await responseJson(await dashboard(`apps/${appId}/credentials`), 200),
        listAuditEvents: async () =>
            await responseJson(await dashboard(`platform/tenants/${tenant.tenantId}/audit-events`), 200),
        requestRotation: async (credentialId = defaultCredential.credentialId) =>
            await dashboard(`platform/app-credentials/${credentialId}/rotate`, {
                overlapSeconds: 60,
            }),
        authenticateApp,
        deleteApp: async () =>
            await worker.fetch(
                new Request(`${origin}/dashboard/v1/apps/${appId}`, {
                    headers: developerHeaders,
                    method: "DELETE",
                }),
                env,
            ),
        listApps: async () => await dashboard(`platform/tenants/${tenant.tenantId}/apps`),
        listProjects: async () => await dashboard(`apps/${appId}/projects`),
        issueScopedCredential: async () =>
            v.parse(
                credentialResource,
                await responseJson(
                    await dashboard(`apps/${appId}/credentials`, {
                        permissions: ["session:read", "session:write"],
                        projectIds: [projectId],
                    }),
                    201,
                ),
            ),
        authenticateSession: async (directory = env.PLATFORM_DIRECTORY_DATABASE) =>
            await runInDurableObject(env.RUNTIME_RELAY.getByName(runtimeId), async (_instance, state) => {
                const relay = new RuntimeRelay(state, {
                    ...env,
                    MOBIUS_PLATFORM_ALLOWED_ORIGINS: '["*"]',
                    MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                    MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
                    PLATFORM_DIRECTORY_DATABASE: directory,
                });
                return await relay.fetch(
                    new Request(
                        `${origin}/v1/projects/${projectId}/sessions/${sessionId}/live-event-subscription-target`,
                        { headers: { authorization: `Bearer ${session.credential}` } },
                    ),
                );
            }),
        revoke: async () =>
            await responseJson(
                await dashboard(`platform/app-credentials/${defaultCredential.credentialId}/revoke`, {}),
                200,
            ),
        rotate: async () =>
            await developer.rotateAppCredential(defaultCredential.credentialId, 60, new AbortController().signal),
        publishOldCache: async () => {
            await env.APP_CREDENTIAL_CACHE.put(`app-secret:v1:${keys.secret_digest}`, legacyCacheRecord);
            await env.APP_CREDENTIAL_CACHE.put(`app-public:v1:${keys.public_credential_id}`, legacyCacheRecord);
        },
    };
}

async function expectRejected(response: Response, code: string, status = 401): Promise<void> {
    expect.soft(response.status).toBe(status);
    expect.soft(await response.json()).toMatchObject({ error: { code } });
}

it.each(["rotated", "revoked"] as const)(
    "Given a %s AppCredential, When rotation is retried, Then it returns the existing conflict without creating a credential or success audit",
    async (state) => {
        const app = await application();
        if (state === "rotated") {
            await app.rotate();
        } else {
            await app.revoke();
        }
        const credentials = await app.listCredentials();
        const audits = await app.listAuditEvents();

        await expectRejected(await app.requestRotation(), "app_credential_rotation_conflict", 409);

        expect(await app.listCredentials()).toEqual(credentials);
        expect(await app.listAuditEvents()).toEqual(audits);
    },
);

it("Given an active AppCredential, When two rotations compete, Then only the returned replacement is created and audited", async () => {
    const app = await application();
    const source = await app.issueScopedCredential();
    const responses = await Promise.all([
        app.requestRotation(source.credentialId),
        app.requestRotation(source.credentialId),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const succeeded = responses.find((response) => response.status === 201);
    const conflicted = responses.find((response) => response.status === 409);
    if (succeeded === undefined || conflicted === undefined) {
        throw new Error("Expected one successful rotation and one conflict");
    }
    const replacement = v.parse(credentialResource, await responseJson(succeeded, 201));
    await expectRejected(conflicted, "app_credential_rotation_conflict", 409);
    const { credentials } = v.parse(
        v.object({ credentials: v.array(v.object({ credentialId: v.string() })) }),
        await app.listCredentials(),
    );
    expect(credentials.map((item) => item.credentialId).sort()).toEqual(
        [app.defaultCredential.credentialId, source.credentialId, replacement.credentialId].sort(),
    );
    const { events } = v.parse(
        v.object({ events: v.array(v.object({ action: v.string(), subjectId: v.string() })) }),
        await app.listAuditEvents(),
    );
    expect(events.filter((event) => event.action === "app-credential.rotated")).toEqual([
        { action: "app-credential.rotated", subjectId: source.credentialId },
    ]);
    expect((await app.authenticateApp(replacement.credential)).status).toBe(201);
});

it("Given an active AppCredential, When rotation storage fails, Then the credential and audit changes roll back and a retry succeeds", async () => {
    const app = await application();
    const credentials = await app.listCredentials();
    const audits = await app.listAuditEvents();
    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `CREATE TRIGGER reject_rotation_audit BEFORE INSERT ON platform_dashboard_audit_events
         WHEN NEW.action = 'app-credential.rotated'
         BEGIN SELECT RAISE(ABORT, 'Controlled rotation failure'); END`,
    ).run();
    try {
        await expectRejected(await app.requestRotation(), "internal_error", 500);
        expect(await app.listCredentials()).toEqual(credentials);
        expect(await app.listAuditEvents()).toEqual(audits);
    } finally {
        await env.PLATFORM_DIRECTORY_DATABASE.prepare("DROP TRIGGER reject_rotation_audit").run();
    }
    const replacement = await app.rotate();
    expect((await app.authenticateApp(replacement.credential)).status).toBe(201);
});

it("Given an active AppCredential and its Session credential, When revocation succeeds before an old cache fill arrives, Then both reject new requests", async () => {
    const app = await application();
    expect((await app.authenticateSession()).status).toBe(200);
    await app.revoke();
    await app.publishOldCache();

    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
});

it("Given a rotated AppCredential with a stale cache record, When the overlap ends, Then its App and Session credentials fail while its replacement works", async () => {
    const app = await application();
    const replacement = await app.rotate();
    await app.publishOldCache();
    vi.setSystemTime(new Date(Date.parse(replacement.overlapEndsAt) - 1));
    expect((await app.authenticateApp()).status).toBe(201);
    expect((await app.authenticateSession()).status).toBe(200);

    vi.setSystemTime(new Date(replacement.overlapEndsAt));
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
    expect((await app.authenticateApp(replacement.credential)).status).toBe(201);
});

it("Given previously valid App and Session credentials, When directory storage is unavailable, Then neither can authorize from an old cache record", async () => {
    const app = await application();
    await app.publishOldCache();

    await expectRejected(
        await app.authenticateApp(undefined, env.TEST_UNINITIALIZED_SHARD),
        "database_unavailable",
        503,
    );
    await expectRejected(await app.authenticateSession(env.TEST_UNINITIALIZED_SHARD), "database_unavailable", 503);
});

it("Given an active App and Project, When deletion rolls back and is retried, Then access remains until deletion commits and the App disappears from the active list", async () => {
    const app = await application();
    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `CREATE TRIGGER reject_project_deletion BEFORE UPDATE OF lifecycle ON platform_projects
         WHEN NEW.lifecycle = 'deleted'
         BEGIN SELECT RAISE(ABORT, 'Controlled deletion failure'); END`,
    ).run();
    try {
        await expectRejected(await app.deleteApp(), "internal_error", 500);
        expect(await responseJson(await app.listProjects(), 200)).toMatchObject({
            projects: [{ projectId: app.projectId, lifecycle: "active" }],
        });
        expect((await app.authenticateApp()).status).toBe(201);
        expect((await app.authenticateSession()).status).toBe(200);
    } finally {
        await env.PLATFORM_DIRECTORY_DATABASE.prepare("DROP TRIGGER reject_project_deletion").run();
    }

    expect(await responseJson(await app.deleteApp(), 200)).toMatchObject({ lifecycle: "deleted" });
    const { apps } = v.parse(
        v.object({ apps: v.array(v.object({ appId: v.string() })) }),
        await responseJson(await app.listApps(), 200),
    );
    expect(apps.map((item) => item.appId)).not.toContain(app.appId);
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
});

it("Given an active Project with App and Session credentials, When its directory lifecycle is suspended, Then listing and every credential observe the suspension", async () => {
    const app = await application();
    const scoped = await app.issueScopedCredential();
    expect((await app.authenticateApp(scoped.credential)).status).toBe(201);
    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        "UPDATE platform_projects SET lifecycle = 'suspended', suspended_at = ? WHERE project_id = ?",
    )
        .bind(Date.now(), app.projectId)
        .run();

    expect(await responseJson(await app.listProjects(), 200)).toMatchObject({
        projects: [{ projectId: app.projectId, lifecycle: "suspended" }],
    });
    await expectRejected(await app.authenticateApp(), "project_access_denied", 403);
    await expectRejected(await app.authenticateApp(scoped.credential), "project_access_denied", 403);
    await expectRejected(await app.authenticateSession(), "project_access_denied", 403);
});
