import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectDatabaseAdapter } from "@moxt-ai/mobius-relay-core";
import { StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";
import { MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { channelHostCredential } from "../../relay-core/src/schema/project-do/index.ts";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { RuntimeRelay } from "../src/durable-objects/runtime-relay.ts";
import { ProjectDurableObjectStores } from "../src/gateway/project-durable-object-store.ts";
import { PlatformControlPlaneStorage } from "../src/storage/platform-control-plane-storage.ts";
import { SqlitePlatformProjectStore } from "../src/storage/sqlite-platform-project-store.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

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
        () => clerk.organizationGateway,
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
    const createdApp = await responseJson(
        await dashboard("apps", { displayName: "Credential authority", tenantId: tenant.tenantId }),
        201,
    );
    const { appId, defaultCredential } = v.parse(
        v.object({ appId: v.string(), defaultCredential: credentialResource }),
        createdApp,
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
                        MOBIUS_PROJECT_STORE: new SqlitePlatformProjectStore(
                            projectId,
                            new DurableObjectDatabaseAdapter(state.storage),
                        ),
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

    return {
        appId,
        createdApp,
        developer,
        tenantId: tenant.tenantId,
        readApp: async () => await responseJson(await dashboard(`apps/${appId}`), 200),
        projectId,
        defaultCredential,
        dashboard,
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
        createProject: async (idempotencyKey: string) =>
            v.parse(
                v.object({ projectId: v.string() }),
                await responseJson(
                    await dashboard(`apps/${appId}/projects`, {
                        displayName: idempotencyKey,
                        idempotencyKey,
                        locationHint: "apac",
                    }),
                    201,
                ),
            ),
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
        openRuntimeHost: async (hostRuntimeId: string) =>
            await worker.fetch(
                new Request(
                    `${origin}/v1/projects/${projectId}/runtimes/${hostRuntimeId}/host?token=${defaultCredential.credential}`,
                    { headers: { Upgrade: "websocket" } },
                ),
                env,
            ),
        revoke: async () =>
            await responseJson(
                await dashboard(`platform/app-credentials/${defaultCredential.credentialId}/revoke`, {}),
                200,
            ),
        rotate: async () =>
            await developer.rotateAppCredential(defaultCredential.credentialId, 60, new AbortController().signal),
    };
}

function expectedScope(credentialId: string, projectIds: readonly string[]) {
    return expect.objectContaining({ allProjects: false, credentialId, projectIds });
}

it("Given an App's initial credential, When it is rotated, revoked and the App is deleted, Then App resources retain its historical ID", async () => {
    const app = await application();
    const signal = new AbortController().signal;
    const initialCredentialId = app.defaultCredential.credentialId;
    const expected = { initialCredentialId };
    expect(app.createdApp).toMatchObject(expected);
    expect(app.createdApp).not.toHaveProperty("defaultCredentialId");
    expect(await app.readApp()).toMatchObject(expected);

    const replacement = await app.rotate();
    expect(replacement.credentialId).not.toBe(initialCredentialId);
    await app.revoke();

    const resource = await app.readApp();
    expect(resource).toMatchObject(expected);
    const listed = await app.developer.listApps(app.tenantId, signal);
    expect(listed.find((item) => item.appId === app.appId)).toMatchObject(expected);
    expect(await app.developer.updateApp(app.appId, "Renamed credential authority", signal)).toMatchObject(expected);
    expect(await app.developer.deleteApp(app.appId, signal)).toMatchObject({ ...expected, lifecycle: "deleted" });
});

async function expectRejected(response: Response, code: string, status = 401): Promise<void> {
    expect.soft(response.status).toBe(status);
    expect.soft(await response.json()).toMatchObject({ error: { code } });
}

it("Given independently issued and rotated credentials, When one is revoked by ID, Then the other remains listed and authorized", async () => {
    const app = await application();
    const signal = new AbortController().signal;
    const issued = await app.developer.issueAppCredential(
        app.appId,
        { permissions: ["session:read", "session:write"], projectIds: [app.projectId] },
        signal,
    );
    const rotated = await app.rotate();

    expect(issued.credentialId).not.toBe(rotated.credentialId);
    expect(rotated.replacedCredentialId).toBe(app.defaultCredential.credentialId);
    expect((await app.authenticateApp(issued.credential)).status).toBe(201);
    expect((await app.authenticateApp(rotated.credential)).status).toBe(201);

    await app.developer.revokeAppCredential(issued.credentialId, signal);

    await expectRejected(await app.authenticateApp(issued.credential), "credential_revoked");
    expect((await app.authenticateApp(rotated.credential)).status).toBe(201);
    expect(await app.developer.listAppCredentials(app.appId, signal)).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ active: false, credentialId: issued.credentialId }),
            expect.objectContaining({ active: true, credentialId: rotated.credentialId }),
        ]),
    );
});

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

it("Given a revoked AppCredential, When it is revoked again, Then the repeat fails and only the revocation that happened is audited", async () => {
    const app = await application();
    await app.revoke();

    await expectRejected(
        await app.dashboard(`platform/app-credentials/${app.defaultCredential.credentialId}/revoke`, {}),
        "app_credential_not_found",
        404,
    );

    const { events } = v.parse(
        v.object({ events: v.array(v.object({ action: v.string(), subjectId: v.string() })) }),
        await app.listAuditEvents(),
    );
    expect(events.filter((event) => event.action === "app-credential.revoked")).toEqual([
        { action: "app-credential.revoked", subjectId: app.defaultCredential.credentialId },
    ]);
});

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

// Workers before D1 owned AppCredential scope wrote it only to Project storage.
async function moveScopeToProjectStorage(credentialId: string, projectId: string): Promise<void> {
    await runInDurableObject(env.PROJECT_RELAY.getByName(projectId), (_instance, state) =>
        state.storage.sql.exec(
            "INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at) VALUES (?, ?, ?)",
            credentialId,
            projectId,
            Date.now(),
        ),
    );
    await env.PLATFORM_DIRECTORY_DATABASE.prepare("DELETE FROM platform_app_credential_scopes WHERE credential_id = ?")
        .bind(credentialId)
        .run();
}

it("Given a scoped AppCredential whose scope only Project storage holds, When it is used, listed and rotated, Then it keeps exactly that scope", async () => {
    const app = await application();
    await app.createProject("credential-authority-other-project");
    const legacy = await app.issueScopedCredential();
    await moveScopeToProjectStorage(legacy.credentialId, app.projectId);

    expect((await app.authenticateApp(legacy.credential)).status).toBe(201);
    expect(await app.listCredentials()).toMatchObject({
        credentials: expect.arrayContaining([expectedScope(legacy.credentialId, [app.projectId])]),
    });
    const replacement = v.parse(
        credentialResource,
        await responseJson(await app.requestRotation(legacy.credentialId), 201),
    );
    expect((await app.authenticateApp(replacement.credential)).status).toBe(201);
    expect(await app.listCredentials()).toMatchObject({
        credentials: expect.arrayContaining([expectedScope(replacement.credentialId, [app.projectId])]),
    });
});

it("Given a scoped AppCredential whose scope only Project storage holds, When an unrelated Project's storage fails, Then it is still authorized for its own Project", async () => {
    const app = await application();
    const other = await app.createProject("credential-authority-failing-project");
    const legacy = await app.issueScopedCredential();
    await moveScopeToProjectStorage(legacy.credentialId, app.projectId);
    await runInDurableObject(env.PROJECT_RELAY.getByName(other.projectId), (_instance, state) =>
        state.storage.sql.exec("DROP TABLE platform_app_credential_projects"),
    );

    expect((await app.authenticateApp(legacy.credential)).status).toBe(201);
});

it("Given a Tenant whose active Projects across its Apps reach the quota, When one of its Apps creates another Project, Then the quota rejects it", async () => {
    const app = await application();
    const { appId, tenantId } = v.parse(v.object({ appId: v.string(), tenantId: v.string() }), await app.readApp());
    const { appId: otherAppId } = v.parse(
        v.object({ appId: v.string() }),
        await responseJson(await app.dashboard("apps", { displayName: "Second quota App", tenantId }), 201),
    );
    const createProject = async (projectAppId: string, idempotencyKey: string) =>
        await app.dashboard(`apps/${projectAppId}/projects`, {
            displayName: idempotencyKey,
            idempotencyKey,
            locationHint: "apac",
        });
    await responseJson(await createProject(otherAppId, "other-app-quota-project"), 201);
    const { activeProjects } = v.parse(
        v.object({ activeProjects: v.number() }),
        await responseJson(await app.dashboard(`platform/tenants/${tenantId}/usage`), 200),
    );
    const setQuota = async (projects: number) =>
        await env.PLATFORM_DIRECTORY_DATABASE.prepare("UPDATE platform_tenants SET quotas_json = ? WHERE tenant_id = ?")
            .bind(JSON.stringify({ activeApps: 100, activeProjects: projects }), tenantId)
            .run();
    await setQuota(activeProjects);
    try {
        await expectRejected(
            await createProject(appId, "quota-overflow-project"),
            "tenant_project_quota_exceeded",
            429,
        );
    } finally {
        await setQuota(1_000);
    }
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

it("Given an active AppCredential and its Session credential, When revocation succeeds, Then both reject new requests", async () => {
    const app = await application();
    expect((await app.authenticateSession()).status).toBe(200);
    await app.revoke();

    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
});

it("Given a rotated AppCredential and its Session credential, When the overlap ends, Then its App and Session credentials fail while its replacement works", async () => {
    const app = await application();
    const replacement = await app.rotate();
    vi.setSystemTime(new Date(Date.parse(replacement.overlapEndsAt) - 1));
    expect((await app.authenticateApp()).status).toBe(201);
    expect((await app.authenticateSession()).status).toBe(200);

    vi.setSystemTime(new Date(replacement.overlapEndsAt));
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
    expect((await app.authenticateApp(replacement.credential)).status).toBe(201);
});

it("Given a rotated AppCredential, When its overlap ends, Then the credential list reports it inactive exactly when authentication rejects it", async () => {
    const app = await application();
    const replacement = await app.rotate();
    const listedActivity = async () =>
        Object.fromEntries(
            v
                .parse(
                    v.object({ credentials: v.array(v.object({ credentialId: v.string(), active: v.boolean() })) }),
                    await app.listCredentials(),
                )
                .credentials.map((credential) => [credential.credentialId, credential.active]),
        );

    vi.setSystemTime(new Date(Date.parse(replacement.overlapEndsAt) - 1));
    expect((await app.authenticateApp()).status).toBe(201);
    expect(await listedActivity()).toEqual({
        [app.defaultCredential.credentialId]: true,
        [replacement.credentialId]: true,
    });

    vi.setSystemTime(new Date(replacement.overlapEndsAt));
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    expect(await listedActivity()).toEqual({
        [app.defaultCredential.credentialId]: false,
        [replacement.credentialId]: true,
    });
});

it("Given previously valid App and Session credentials, When directory storage is unavailable, Then neither authorizes", async () => {
    const app = await application();

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

it("Given an App with two active Projects, When its owner deletes it, Then deletion is atomic and terminal", async () => {
    const app = await application();
    const activeProject = await app.createProject("active-project");
    const beforeDeletion = await app.readApp();
    const projectsBeforeDeletion = await responseJson(await app.listProjects(), 200);
    const auditsBeforeDeletion = await app.listAuditEvents();

    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `CREATE TRIGGER reject_app_deletion BEFORE UPDATE OF lifecycle ON platform_projects
         WHEN NEW.lifecycle = 'deleted'
         BEGIN SELECT RAISE(ABORT, 'Controlled deletion failure'); END`,
    ).run();
    try {
        await expectRejected(await app.deleteApp(), "internal_error", 500);
        expect(await app.readApp()).toEqual(beforeDeletion);
        expect(await responseJson(await app.listProjects(), 200)).toEqual(projectsBeforeDeletion);
        expect(await app.listAuditEvents()).toEqual(auditsBeforeDeletion);
    } finally {
        await env.PLATFORM_DIRECTORY_DATABASE.prepare("DROP TRIGGER reject_app_deletion").run();
    }

    const deletedAt = "2026-10-27T00:01:00.000Z";
    vi.setSystemTime(new Date(deletedAt));
    const deleted = await responseJson(await app.deleteApp(), 200);
    expect(deleted).toMatchObject({
        appId: app.appId,
        lifecycle: "deleted",
        deletedAt,
        updatedAt: deletedAt,
    });
    expect(await app.developer.readApp(app.appId, new AbortController().signal)).toMatchObject({
        lifecycle: "deleted",
        deletedAt,
    });
    expect(await responseJson(await app.listProjects(), 200)).toMatchObject({
        projects: expect.arrayContaining([
            expect.objectContaining({ projectId: app.projectId, lifecycle: "deleted", deletedAt }),
            expect.objectContaining({ projectId: activeProject.projectId, lifecycle: "deleted", deletedAt }),
        ]),
    });
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
    const auditsAfterDeletion = await app.listAuditEvents();
    await expectRejected(await app.deleteApp(), "app_access_denied", 403);
    expect(await app.readApp()).toEqual(deleted);
    expect(await app.listAuditEvents()).toEqual(auditsAfterDeletion);
});

it("Given an App deleted while its Project and AppCredential stayed active, When the lifecycle migration runs, Then both end at the App's deletion and neither authorizes", async () => {
    const app = await application();
    const deletedAt = "2026-10-27T00:01:00.000Z";
    const directory = env.PLATFORM_DIRECTORY_DATABASE;
    // The state a Project creation or credential issuance racing an earlier App deletion could leave behind.
    await directory
        .prepare("UPDATE platform_apps SET lifecycle = 'deleted', deleted_at = ?, updated_at = ? WHERE app_id = ?")
        .bind(Date.parse(deletedAt), Date.parse(deletedAt), app.appId)
        .run();
    const migration = env.TEST_PLATFORM_MIGRATIONS.find(
        (candidate) => candidate.name === "0011_end_lifecycle_with_app.sql",
    );
    if (migration === undefined) {
        throw new Error("Expected the lifecycle migration");
    }

    await directory.batch(migration.queries.map((query) => directory.prepare(query)));

    expect(await responseJson(await app.listProjects(), 200)).toMatchObject({
        projects: [{ projectId: app.projectId, lifecycle: "deleted", deletedAt, updatedAt: deletedAt }],
    });
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    await expectRejected(await app.authenticateSession(), "credential_revoked");
});

it("Given an App deleted after a request checked it, When that request creates a Project or issues an AppCredential, Then neither is created", async () => {
    const app = await application();
    expect((await app.deleteApp()).status).toBe(200);
    const storage = new PlatformControlPlaneStorage(
        env.PLATFORM_DIRECTORY_DATABASE,
        new ProjectDurableObjectStores(env.PROJECT_RELAY),
    );
    const signal = new AbortController().signal;
    const now = Date.now();
    const audit = {
        action: "stale.request",
        actorId: "developer-1",
        actorKind: "platform_developer",
        actorRef: "",
        appId: app.appId,
        auditId: "stale-request-audit",
        detailsJson: "{}",
        outcome: "succeeded",
        projectId: "",
        recordedAt: now,
        subjectId: app.appId,
        tenantId: app.tenantId,
    };

    const project = await storage.createProject(
        {
            app_id: app.appId,
            client_reference: "stale-project",
            created_at: now,
            deleted_at: null,
            display_name: "Stale Project",
            idempotency_key: "stale-project",
            lifecycle: "active",
            location_hint: "apac",
            project_id: "stale-project",
            request_digest: "stale-digest",
            tenant_id: app.tenantId,
            updated_at: now,
        },
        100,
        audit,
        signal,
    );
    const credentialIssued = await storage.issueAppCredential(
        {
            allProjects: true,
            appId: app.appId,
            credentialId: "stale-credential",
            issuedAt: now,
            permissionsJson: "[]",
            publicCredentialId: "stale-public-credential",
            secretDigest: "stale-digest",
        },
        [],
        audit,
        signal,
    );

    expect(project).toEqual({ projectCreated: false, auditRecorded: false });
    expect(credentialIssued).toBe(false);
    expect(await storage.listActiveProjectIds(app.appId, signal)).toEqual([]);
    expect((await storage.listAppCredentials(app.appId, signal)).map((row) => row.credential_id)).toEqual([
        app.defaultCredential.credentialId,
    ]);
});

it("Given a Project created through the dashboard, When its developer lists the Project's audit events, Then the Worker reads the creation event from the Project's own storage", async () => {
    const app = await application();

    const listed = await responseJson(await app.dashboard(`projects/${app.projectId}/audit-events`), 200);

    expect(listed).toMatchObject({
        events: expect.arrayContaining([
            expect.objectContaining({
                action: "project.created",
                auditId: `pae_created_${app.projectId}`,
                outcome: "succeeded",
                projectId: app.projectId,
                subjectId: app.projectId,
                tenantId: app.tenantId,
            }),
        ]),
    });
});

it("Given a Runtime host connection opened with an AppCredential, When the AppCredential is revoked, Then the connection's next message is refused and the Relay kept no copy of that authority", async () => {
    const app = await application();
    const hostRuntimeId = "credential-authority-host-runtime";
    await registerRuntimeFixture(app.projectId, hostRuntimeId);
    const opened = await app.openRuntimeHost(hostRuntimeId);
    expect(opened.status).toBe(101);
    const host = opened.webSocket;
    if (host === null) {
        throw new Error("Expected a Runtime host connection");
    }
    const closed = Promise.withResolvers<{ readonly code: number; readonly reason: string }>();
    host.addEventListener("close", (event) => closed.resolve({ code: event.code, reason: event.reason }), {
        once: true,
    });
    host.accept();
    const storedHostCredentials = await runInDurableObject(
        env.PROJECT_RELAY.getByName(app.projectId),
        async (_instance, state) =>
            await relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000))
                .select({ credentialId: channelHostCredential.credentialId })
                .from(channelHostCredential),
    );

    await app.revoke();
    host.send(JSON.stringify({ kind: "runtime.ping", requestId: "ping_after_revocation" }));

    expect(storedHostCredentials).toEqual([]);
    expect(await closed.promise).toEqual({ code: 1008, reason: "Channel access revoked" });
});
