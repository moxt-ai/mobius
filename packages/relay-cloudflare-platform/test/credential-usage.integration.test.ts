import {
    abortAllDurableObjects,
    applyD1Migrations,
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";
import {
    MobiusPlatformAppClient,
    MobiusPlatformAppCredentialMetadata,
    MobiusPlatformDeveloperClient,
} from "@moxt-ai/mobius-sdk/platform";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { PlatformControlPlaneStorage } from "../src/storage/platform-control-plane-storage.ts";
import { PlatformDatabaseResolver } from "../src/storage/platform-database-resolver.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";

const origin = `https://platform.test${MOBIUS_API_PREFIX}`;
const issuedAt = "2026-10-28T00:00:00.000Z";
const signal = new AbortController().signal;
const clerk = new FakeClerk();

// Independent SDK 0.0.134 reader contract and response retained from 5759985.
const legacyIdentifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/));
const legacyTimestamp = v.pipe(
    v.string(),
    v.maxLength(128),
    v.check((value) => value.length === 0 || !Number.isNaN(Date.parse(value))),
);
const legacyStrings = v.pipe(v.array(v.string()), v.maxLength(100));
const legacyCredential = v.object({
    active: v.optional(v.boolean()),
    allProjects: v.boolean(),
    appId: legacyIdentifier,
    credentialId: legacyIdentifier,
    issuedAt: legacyTimestamp,
    lastUsedAt: legacyTimestamp,
    overlapEndsAt: legacyTimestamp,
    permissions: legacyStrings,
    projectIds: legacyStrings,
    publicCredentialId: v.pipe(v.string(), v.maxLength(64)),
    replacedByCredentialId: v.pipe(v.string(), v.maxLength(128)),
    revision: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    revokedAt: legacyTimestamp,
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(issuedAt));
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
    const credential = clerk.session("developer-1", clerk.defaultOrganizationId);
    const transport = {
        fetch: async (request: Request) => {
            const context = createExecutionContext();
            const response = await worker.fetch(request, env, context);
            await waitOnExecutionContext(context);
            return response;
        },
    };
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: origin,
        authenticationProviderId: "clerk",
        credentialProvider: new StaticMobiusCredentialProvider(credential),
        transport,
    });
    const tenant = (await developer.listTenants(signal))[0];
    if (tenant === undefined) {
        throw new Error("Expected a Tenant");
    }
    const app = await developer.createApp(tenant.tenantId, "Credential usage", signal);
    return {
        app,
        developer,
        storage: new PlatformControlPlaneStorage(env.PLATFORM_DIRECTORY_DATABASE, new PlatformDatabaseResolver(env)),
        list: async () => await developer.listAppCredentials(app.appId, signal),
        listRaw: async () => {
            const response = await transport.fetch(
                new Request(`${origin}/dashboard/v1/apps/${app.appId}/credentials`, {
                    headers: { authorization: `Bearer ${credential}`, "x-mobius-oidc-provider": "clerk" },
                }),
            );
            expect(response.status).toBe(200);
            const body: unknown = await response.json();
            return body;
        },
        use: async () =>
            await new MobiusPlatformAppClient({
                endpoint: origin,
                credentialProvider: new StaticMobiusCredentialProvider(app.defaultCredential.credential),
                transport,
            }).createProject(
                app.appId,
                {
                    clientReference: "usage-project",
                    displayName: "Usage Project",
                    idempotencyKey: "usage-project",
                    locationHint: "apac",
                },
                signal,
            ),
    };
}

it("Given newly issued credentials, When one is used at its issuance time, Then only that credential has an observation and legacy readers still accept the list", async () => {
    const app = await application();
    expect(await app.list()).toEqual([expect.objectContaining({ lastUsedAt: issuedAt, lastObservedUsedAt: null })]);
    const project = await app.use();
    const scoped = await app.developer.issueAppCredential(
        app.app.appId,
        { permissions: ["session:read"], projectIds: [project.projectId] },
        signal,
    );
    const replacement = await app.developer.rotateAppCredential(scoped.credentialId, 60, signal);
    const credentials = await app.list();
    expect(credentials).toHaveLength(3);
    expect(credentials.find((item) => item.credentialId === app.app.defaultCredential.credentialId)).toMatchObject({
        lastObservedUsedAt: issuedAt,
    });
    for (const credentialId of [scoped.credentialId, replacement.credentialId]) {
        expect(credentials.find((item) => item.credentialId === credentialId)).toMatchObject({
            lastUsedAt: issuedAt,
            lastObservedUsedAt: null,
        });
    }
    const oldView = v.parse(v.object({ credentials: v.array(legacyCredential) }), await app.listRaw());
    expect(oldView.credentials).toHaveLength(3);
    expect(oldView.credentials.every((item) => item.lastUsedAt === issuedAt)).toBe(true);
});

it("Given usage writes completing out of order, When an older observation arrives last, Then neither timestamp regresses and revocation still prevents updates", async () => {
    const app = await application();
    const credentialId = app.app.defaultCredential.credentialId;
    const later = Date.parse(issuedAt) + 2_000;
    await app.storage.touchCredential(credentialId, later, signal);
    await app.storage.touchCredential(credentialId, later, signal);
    await app.storage.touchCredential(credentialId, later - 1_000, signal);
    expect(await app.list()).toEqual([
        expect.objectContaining({
            lastUsedAt: new Date(later).toISOString(),
            lastObservedUsedAt: new Date(later).toISOString(),
        }),
    ]);
    await app.developer.revokeAppCredential(credentialId, signal);
    expect(await app.storage.touchCredential(credentialId, later + 1_000, signal)).toBe(false);
    expect((await app.list())[0]?.lastObservedUsedAt).toBe(new Date(later).toISOString());
});

it("Given the retained old server response, When the new SDK reads it, Then missing usage evidence remains unknown without changing legacy metadata", () => {
    const oldResponse = {
        active: true,
        allProjects: true,
        appId: "app-1",
        credentialId: "credential-1",
        issuedAt,
        lastUsedAt: issuedAt,
        overlapEndsAt: "",
        permissions: ["session:read"],
        projectIds: [],
        publicCredentialId: "public-1",
        replacedByCredentialId: "",
        revision: 1,
        revokedAt: "",
    };
    expect(new MobiusPlatformAppCredentialMetadata(oldResponse)).toMatchObject({
        ...oldResponse,
        lastObservedUsedAt: null,
    });
});

it("Given a credential whose use was just recorded, When it is used again within a minute, Then the recorded use stays until a minute has passed", async () => {
    const app = await application();
    await app.use();
    vi.setSystemTime(Date.parse(issuedAt) + 59_000);
    await app.use();
    expect((await app.list())[0]?.lastObservedUsedAt).toBe(issuedAt);
    const minuteLater = new Date(Date.parse(issuedAt) + 60_000).toISOString();
    vi.setSystemTime(Date.parse(minuteLater));
    await app.use();
    expect((await app.list())[0]?.lastObservedUsedAt).toBe(minuteLater);
});

it("Given a failed background usage write, When authentication succeeds, Then usage remains unknown and can be recorded on a later request", async () => {
    const app = await application();
    await env.PLATFORM_DIRECTORY_DATABASE.exec(
        "CREATE TRIGGER reject_usage_observation BEFORE UPDATE OF last_observed_used_at ON platform_app_credentials BEGIN SELECT RAISE(ABORT, 'usage write unavailable'); END",
    );
    try {
        expect((await app.use()).appId).toBe(app.app.appId);
        expect((await app.list())[0]?.lastObservedUsedAt).toBeNull();
    } finally {
        await env.PLATFORM_DIRECTORY_DATABASE.exec("DROP TRIGGER reject_usage_observation");
    }
    await app.use();
    expect((await app.list())[0]?.lastObservedUsedAt).toBe(issuedAt);
});

it("Given legacy credential rows, When storage is migrated and old and new Workers write, Then history stays unknown until observed and both record formats remain readable", async () => {
    const database = env.TEST_CREDENTIAL_USAGE_DATABASE;
    // Retain the schema and writer from 5759985, independently of the current Drizzle schema.
    await applyD1Migrations(
        database,
        env.TEST_PLATFORM_MIGRATIONS.filter((migration) => migration.name <= "0006_melodic_titanium_man.sql"),
    );
    const issued = Date.parse(issuedAt);
    await database.batch([
        database.prepare(
            "INSERT INTO platform_tenants (tenant_id, display_name, lifecycle, quotas_json, created_at, updated_at) VALUES ('legacy-tenant', 'Legacy', 'active', '{}', 0, 0)",
        ),
        database.prepare(
            "INSERT INTO platform_apps (app_id, tenant_id, display_name, lifecycle, created_at, updated_at) VALUES ('legacy-app', 'legacy-tenant', 'Legacy', 'active', 0, 0)",
        ),
    ]);
    const oldInsert = async (id: string, lastUsed: number) =>
        await database
            .prepare(
                "INSERT INTO platform_app_credentials (credential_id, public_credential_id, app_id, secret_digest, permissions_json, all_projects, revision, issued_at, last_used_at) VALUES (?, ?, 'legacy-app', 'digest', '[]', 1, 1, ?, ?)",
            )
            .bind(id, id, issued, lastUsed)
            .run();
    await oldInsert("legacy-unobserved", issued);
    await oldInsert("legacy-used", issued + 1_000);
    await applyD1Migrations(database, env.TEST_PLATFORM_MIGRATIONS);
    const storage = new PlatformControlPlaneStorage(database, new PlatformDatabaseResolver(env));
    for (const id of ["legacy-unobserved", "legacy-used"]) {
        expect(await storage.readCredentialById(id, signal)).toMatchObject({
            credential_id: id,
            last_observed_used_at: null,
            secret_digest: "digest",
        });
    }
    await oldInsert("rollback-issued", issued);
    expect(await storage.readCredentialById("rollback-issued", signal)).toMatchObject({
        last_used_at: issued,
        last_observed_used_at: null,
    });
    await storage.touchCredential("legacy-used", issued + 3_000, signal);
    // An old Worker can still use its legacy read/write contract after the migration.
    expect(
        await database
            .prepare("SELECT last_used_at FROM platform_app_credentials WHERE credential_id = ?")
            .bind("legacy-used")
            .first(),
    ).toEqual({ last_used_at: issued + 3_000 });
    await database
        .prepare(
            "UPDATE platform_app_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)",
        )
        .bind(issued + 1_000, "legacy-used", issued + 1_000)
        .run();
    await storage.touchCredential("legacy-used", issued + 2_000, signal);
    expect(await storage.readCredentialById("legacy-used", signal)).toMatchObject({
        last_used_at: issued + 3_000,
        last_observed_used_at: issued + 3_000,
        secret_digest: "digest",
    });
});
