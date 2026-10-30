import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectDatabaseAdapter } from "@moxt-ai/mobius-relay-core";
import { StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";
import {
    MobiusApiError,
    MobiusConnectionError,
    MobiusPlatformAppClient,
    MobiusPlatformDeveloperClient,
} from "@moxt-ai/mobius-sdk/platform";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { SqlitePlatformProjectStore } from "../src/storage/sqlite-platform-project-store.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";

const origin = `https://platform.test${MOBIUS_API_PREFIX}`;
const clerk = new FakeClerk();

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
    let discardNextResponse = false;
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: origin,
        authenticationProviderId: "clerk",
        credentialProvider: new StaticMobiusCredentialProvider(
            clerk.session("developer-1", clerk.defaultOrganizationId),
        ),
        transport: {
            fetch: async (request) => {
                const discardResponse = discardNextResponse;
                discardNextResponse = false;
                const response = await worker.fetch(request, env);
                if (discardResponse) {
                    await response.body?.cancel();
                    throw new TypeError("Connection lost after the Worker completed the request");
                }
                return response;
            },
        },
    });
    const signal = new AbortController().signal;
    const tenant = (await developer.listTenants(signal))[0];
    if (tenant === undefined) {
        throw new Error("Expected a developer Tenant");
    }
    const app = await developer.createApp(tenant.tenantId, "Credential recovery", signal);
    const project = await developer.createProject(
        app.appId,
        {
            clientReference: "credential-recovery",
            displayName: "Credential recovery Project",
            idempotencyKey: "credential-recovery-project",
            locationHint: "apac",
        },
        signal,
    );
    return {
        appId: app.appId,
        developer,
        tenantId: tenant.tenantId,
        projectId: project.projectId,
        defaultCredential: app.defaultCredential,
        discardNextResponse: () => {
            discardNextResponse = true;
        },
        appClient: (credential: string) =>
            new MobiusPlatformAppClient({
                endpoint: origin,
                credentialProvider: new StaticMobiusCredentialProvider(credential),
                transport: { fetch: async (request) => await worker.fetch(request, env) },
            }),
        authenticateApp: async (credential = app.defaultCredential.credential) =>
            await runInDurableObject(
                env.PROJECT_RELAY.getByName(project.projectId),
                async (_instance, state) =>
                    await worker.fetch(
                        new Request(
                            `${origin}/v1/projects/${project.projectId}/sessions/recovery-session/access-credentials`,
                            {
                                headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
                                body: JSON.stringify({ expiresInSeconds: 900, runtimeId: "recovery-runtime" }),
                                method: "POST",
                            },
                        ),
                        {
                            ...env,
                            MOBIUS_PROJECT_STORE: new SqlitePlatformProjectStore(
                                project.projectId,
                                new DurableObjectDatabaseAdapter(state.storage),
                            ),
                            MOBIUS_PROJECT_ID: project.projectId,
                        },
                    ),
            ),
        rotate: async () => await developer.rotateAppCredential(app.defaultCredential.credentialId, 60, signal),
    };
}

async function expectRejected(response: Response, code: string): Promise<void> {
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code } });
}

it("Given App creation commits but its response is lost, When the caller reconciles the App list, Then it can replace the lost default secret while a same-name retry cannot recover it", async () => {
    const app = await application();
    const signal = new AbortController().signal;
    const before = new Set((await app.developer.listApps(app.tenantId, signal)).map((item) => item.appId));

    app.discardNextResponse();
    await expect(app.developer.createApp(app.tenantId, "Lost App response", signal)).rejects.toBeInstanceOf(
        MobiusConnectionError,
    );

    // This scenario has one writer. A unique name does not identify which concurrent caller created the App.
    const created = (await app.developer.listApps(app.tenantId, signal)).filter((item) => !before.has(item.appId));
    expect(created).toHaveLength(1);
    const lost = created[0];
    if (lost === undefined) {
        throw new Error("Expected the committed App");
    }
    await expect(app.developer.createApp(app.tenantId, "Lost App response", signal)).rejects.toBeInstanceOf(
        MobiusApiError,
    );
    expect(await app.developer.listApps(app.tenantId, signal)).toHaveLength(before.size + 1);
    expect(await app.developer.listAppCredentials(lost.appId, signal)).toEqual([
        expect.objectContaining({ credentialId: lost.initialCredentialId }),
    ]);

    const recovered = await app.developer.rotateAppCredential(lost.initialCredentialId, 0, signal);
    const project = await app.appClient(recovered.credential).createProject(
        lost.appId,
        {
            clientReference: "recovered-app",
            displayName: "Recovered App Project",
            idempotencyKey: "recovered-app-project",
            locationHint: "apac",
        },
        signal,
    );
    expect(project.appId).toBe(lost.appId);
    const credentials = await app.developer.listAppCredentials(lost.appId, signal);
    expect(credentials).toHaveLength(2);
    expect(credentials.find((item) => item.credentialId === lost.initialCredentialId)).toMatchObject({
        overlapEndsAt: new Date().toISOString(),
        replacedByCredentialId: recovered.credentialId,
    });
});

it("Given credential issuance commits but its response is lost, When the caller reconciles and replaces it, Then access is recovered with the same scope while a blind retry leaves another active credential", async () => {
    const app = await application();
    const signal = new AbortController().signal;
    const request = { permissions: ["session:read", "session:write"], projectIds: [app.projectId] };

    app.discardNextResponse();
    await expect(app.developer.issueAppCredential(app.appId, request, signal)).rejects.toBeInstanceOf(
        MobiusConnectionError,
    );

    const credentials = await app.developer.listAppCredentials(app.appId, signal);
    expect(credentials).toHaveLength(2);
    const lost = credentials.find((item) => item.credentialId !== app.defaultCredential.credentialId);
    if (lost === undefined) {
        throw new Error("Expected the committed credential");
    }
    const retried = await app.developer.issueAppCredential(app.appId, request, signal);
    expect(retried.credentialId).not.toBe(lost.credentialId);
    expect(await app.developer.listAppCredentials(app.appId, signal)).toHaveLength(3);
    expect((await app.authenticateApp(retried.credential)).status).toBe(201);

    const recovered = await app.developer.rotateAppCredential(lost.credentialId, 0, signal);
    expect((await app.authenticateApp(recovered.credential)).status).toBe(201);
    const after = await app.developer.listAppCredentials(app.appId, signal);
    expect(after.find((item) => item.credentialId === lost.credentialId)).toMatchObject({
        overlapEndsAt: new Date().toISOString(),
        replacedByCredentialId: recovered.credentialId,
    });
    expect(after.find((item) => item.credentialId === recovered.credentialId)).toMatchObject({
        allProjects: false,
        permissions: request.permissions,
        projectIds: request.projectIds,
    });
    expect(after.find((item) => item.credentialId === retried.credentialId)).toMatchObject({
        replacedByCredentialId: "",
        revokedAt: "",
    });
});

it("Given rotation commits but its response is lost, When the caller follows the replacement ID and rotates it, Then the missing secret is replaced without replaying the original rotation", async () => {
    const app = await application();
    const signal = new AbortController().signal;
    app.discardNextResponse();
    await expect(app.rotate()).rejects.toBeInstanceOf(MobiusConnectionError);

    const before = await app.developer.listAppCredentials(app.appId, signal);
    expect(before).toHaveLength(2);
    const source = before.find((item) => item.credentialId === app.defaultCredential.credentialId);
    if (source === undefined || source.replacedByCredentialId === "") {
        throw new Error("Expected a committed replacement link");
    }
    await expect(app.rotate()).rejects.toMatchObject({ code: "app_credential_rotation_conflict", status: 409 });
    expect(await app.developer.listAppCredentials(app.appId, signal)).toEqual(before);

    const recovered = await app.developer.rotateAppCredential(source.replacedByCredentialId, 0, signal);
    expect((await app.authenticateApp(recovered.credential)).status).toBe(201);
    // The first source retains its original overlap; replacing its successor does not revoke it.
    expect((await app.authenticateApp()).status).toBe(201);
    await app.developer.revokeAppCredential(source.credentialId, signal);
    await expectRejected(await app.authenticateApp(), "credential_revoked");
    expect((await app.authenticateApp(recovered.credential)).status).toBe(201);
    const after = await app.developer.listAppCredentials(app.appId, signal);
    expect(after).toHaveLength(3);
    expect(after.find((item) => item.credentialId === source.replacedByCredentialId)).toMatchObject({
        overlapEndsAt: new Date().toISOString(),
        replacedByCredentialId: recovered.credentialId,
    });
});
