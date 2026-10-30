import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectDatabaseAdapter, DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import {
    channelAccessGrant,
    channelHostCredential,
    runtimePairingAuditEvent,
} from "@moxt-ai/mobius-relay-core/schema/project-do";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashSecret, MAX_RUNTIMES_PER_PROJECT } from "../../relay-core/src/entity/pairing/pairing.ts";
import { RuntimeDirectoryStorage } from "../../relay-core/src/storage/runtime-directory-storage.ts";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { projectDurableObjectMigrations } from "../src/generated/project-do-migrations.ts";
import { pairingChannel } from "../src/schema/legacy-project-do/pairing-channel.ts";
import { initializeProjectDurableObjectSchema } from "../src/storage/project-durable-object-schema.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";

const origin = `https://platform.test${MOBIUS_API_PREFIX}`;
const clerk = new FakeClerk();
const pairingSchema = v.object({
    channelId: v.string(),
    expiresAt: v.string(),
    pairingCode: v.string(),
    pairingId: v.string(),
    pollToken: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
});
type Pairing = Readonly<v.InferOutput<typeof pairingSchema>>;

async function responseJson(response: Response, status: number): Promise<unknown> {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
    clerk.reset();
});
afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

async function project(name = "Runtime pairing") {
    const worker = createTestMobiusPlatformApp(
        new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
        createPlatformGateways,
    );
    const headers = {
        authorization: `Bearer ${clerk.session("developer-1", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    };
    const dashboard = async (path: string, body?: object) =>
        await worker.fetch(
            new Request(`${origin}/dashboard/v1/${path}`, {
                headers,
                ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
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
        v.object({
            appId: v.string(),
            defaultCredential: v.object({ credential: v.string(), credentialId: v.string() }),
        }),
        await responseJson(await dashboard("apps", { displayName: name, tenantId: tenant.tenantId }), 201),
    );
    const { projectId } = v.parse(
        v.object({ projectId: v.string() }),
        await responseJson(
            await dashboard(`apps/${appId}/projects`, {
                displayName: "Runtime pairing Project",
                idempotencyKey: "runtime-pairing-project",
                locationHint: "apac",
            }),
            201,
        ),
    );
    const stub = env.PROJECT_RELAY.getByName(projectId);
    const request = async (path: string, method = "GET", body?: object, token = defaultCredential.credential) => {
        const result = await runInDurableObject(stub, async (_instance, state) => {
            const response = await worker.fetch(
                new Request(`${origin}${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                {
                    ...env,
                    MOBIUS_PROJECT_DATABASE: new DurableObjectDatabaseAdapter(state.storage),
                    MOBIUS_PROJECT_ID: projectId,
                },
            );
            // Consume the HTTP body within its DO request context so an unread
            // error response cannot keep a later eviction waiting for a stream.
            return { body: await response.text(), status: response.status, headers: [...response.headers] };
        });
        return new Response(result.body.length === 0 ? null : result.body, {
            status: result.status,
            headers: result.headers,
        });
    };
    const create = async (idempotencyKey: string) =>
        request(`/v1/projects/${projectId}/runtime-pairings`, "POST", { idempotencyKey });
    return {
        appId,
        projectId,
        credentialId: defaultCredential.credentialId,
        create,
        pair: async (key: string): Promise<Pairing> =>
            v.parse(pairingSchema, await responseJson(await create(key), 201)),
        status: async (pairing: Pairing) => request(`/v1/projects/${projectId}/runtime-pairings/${pairing.pairingId}`),
        claim: async (pairing: Pairing, endpoint: "claim" | "redeem" = "redeem", machineName = "Runtime machine") =>
            request(
                endpoint === "claim" ? "/pairings/claim" : `/v1/runtime-pairings/${pairing.pairingId}/redeem`,
                "POST",
                {
                    pairingCode: pairing.pairingCode,
                    machineName,
                    workspaceName: "Runtime workspace",
                    agents: [],
                },
            ),
        revoke: async (pairing: Pairing) =>
            request(`/v1/projects/${projectId}/runtimes/${pairing.runtimeId}`, "DELETE"),
        list: async () => request(`/v1/projects/${projectId}/runtimes`),
        publish: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.channelId}/catalog`, "PUT", { agents: [] }, token),
        readChannel: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.channelId}`, "GET", undefined, token),
        createGrant: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.channelId}/access-grants`, "POST", undefined, token),
        redeemGrant: async (pairing: Pairing, grantId: string, grantSecret: string) =>
            request(`/channels/${pairing.channelId}/access-grants/${grantId}/redeem`, "POST", { grantSecret }),
        storage: async <T>(operation: (storage: DurableObjectStorage) => Promise<T> | T): Promise<T> =>
            runInDurableObject(stub, async (_instance, state) => operation(state.storage)),
        restart: async () => evictDurableObject(stub),
        sql: async (sql: string) =>
            runInDurableObject(stub, async (_instance, state) => {
                state.storage.sql.exec(sql);
            }),
    };
}

it("Given pending reservations at capacity, When their deadline passes without expiry maintenance, Then status reads and new reservations succeed", async () => {
    const app = await project();
    const pairings = await Promise.all(
        Array.from({ length: MAX_RUNTIMES_PER_PROJECT }, (_, index) => app.pair(`reservation-${index}`)),
    );
    const first = pairings[0];
    if (first === undefined) {
        throw new Error("Expected a pending pairing");
    }
    expect(await responseJson(await app.create("over-capacity"), 429)).toMatchObject({
        error: { code: "runtime_quota_exceeded" },
    });
    // Expiry is the passage of time. Neither reading it nor reclaiming capacity
    // may require persisting a lifecycle transition, even when that write fails.
    await app.sql(`CREATE TRIGGER reject_expiry_maintenance BEFORE INSERT ON runtime_pairing_audit_events
        WHEN NEW.action = 'runtime_pairing.expired'
        BEGIN SELECT RAISE(ABORT, 'Expiry maintenance is unavailable'); END`);
    vi.setSystemTime(new Date(first.expiresAt));
    expect(await responseJson(await app.status(first), 200)).toEqual({ status: "expired" });
    expect(await responseJson(await app.claim(first), 400)).toMatchObject({ error: { code: "invalid_pairing_code" } });
    expect(await app.pair("replacement")).toMatchObject({ projectId: app.projectId });
    expect(await app.pair("reservation-0")).toEqual(first);
});

it("Given simultaneous retries of one creation, When they commit, Then they share one reservation and leave the remaining capacity available", async () => {
    const app = await project();
    const [left, right] = await Promise.all([app.pair("same-request"), app.pair("same-request")]);
    expect(left).toEqual(right);
    await Promise.all(
        Array.from({ length: MAX_RUNTIMES_PER_PROJECT - 1 }, (_, index) => app.pair(`remaining-${index}`)),
    );
    expect((await app.create("no-place")).status).toBe(429);
});

it("Given a delayed claim, When newer requests have reused expired capacity, Then the claim cannot overbook the Project", async () => {
    const app = await project();
    const pairing = await app.pair("delayed-claim");
    const claimTime = Date.now();
    const codeHash = await hashSecret(pairing.pairingCode);
    vi.setSystemTime(new Date(pairing.expiresAt));
    await Promise.all(Array.from({ length: MAX_RUNTIMES_PER_PROJECT }, (_, index) => app.pair(`replacement-${index}`)));
    // Execute the original command against the real Project database after
    // newer transactions, as can happen when a database request is delayed.
    const claimed = await app.storage(async (storage) =>
        new RuntimeDirectoryStorage(app.projectId, new DurableObjectDatabaseAdapter(storage)).claim(
            {
                pairingId: pairing.pairingId,
                codeHash,
                daemonHash: await hashSecret("delayed-runtime-credential"),
                now: claimTime,
                machineName: "Delayed machine",
                workspaceName: "Delayed workspace",
                agents: "[]",
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            new AbortController().signal,
        ),
    );
    expect(claimed).toBe(false);
    expect(await responseJson(await app.status(pairing), 200)).toEqual({ status: "expired" });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
});

it("Given a claim whose audit cannot commit, When the caller retries after recovery, Then the request is still pending and can be claimed once", async () => {
    const app = await project();
    const pairing = await app.pair("claim-rollback");
    await app.sql(`CREATE TRIGGER reject_claim BEFORE INSERT ON runtime_pairing_audit_events
        WHEN NEW.action = 'runtime_pairing.claimed'
        BEGIN SELECT RAISE(ABORT, 'Controlled claim failure'); END`);
    expect((await app.claim(pairing)).status).toBe(500);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
    await app.sql("DROP TRIGGER reject_claim");
    const claimed = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(204);
    expect(await responseJson(await app.claim(pairing), 200)).toMatchObject(claimed);
});

it.each(["claim", "redeem"] as const)(
    "Given a committed %s response is lost, When the caller retries after a relay restart, Then the original credential is recovered without changing the registration",
    async (endpoint) => {
        const app = await project();
        const pairing = await app.pair(`lost-${endpoint}`);
        // Discard the first result before the caller can save its credential.
        expect((await app.claim(pairing, endpoint)).status).toBe(200);
        await app.restart();
        vi.setSystemTime(new Date(Date.now() + 20_000));
        const response = await responseJson(await app.claim(pairing, endpoint, "Retry machine"), 200);
        // Independently retain both released CLI response contracts, including
        // their exact keys and credential syntax.
        const identity = { appId: v.string(), channelId: v.string(), runtimeId: v.string() };
        const credential = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/));
        const runtimeCredential =
            endpoint === "claim"
                ? v.parse(v.strictObject({ ...identity, daemonToken: credential }), response).daemonToken
                : v.parse(v.strictObject({ ...identity, runtimeCredential: credential }), response).runtimeCredential;
        expect(response).toMatchObject({
            appId: app.appId,
            channelId: pairing.channelId,
            runtimeId: pairing.runtimeId,
        });
        expect((await app.publish(pairing, runtimeCredential)).status).toBe(204);
        expect(await responseJson(await app.list(), 200)).toMatchObject({
            runtimes: [{ runtimeId: pairing.runtimeId, machineName: "Runtime machine" }],
        });
        expect(
            await app.storage((storage) =>
                storage.sql.exec("SELECT action FROM runtime_pairing_audit_events ORDER BY action").toArray(),
            ),
        ).toEqual([{ action: "runtime_pairing.claimed" }, { action: "runtime_pairing.requested" }]);
        expect((await app.revoke(pairing)).status).toBe(204);
        expect(await responseJson(await app.claim(pairing, endpoint), 400)).toMatchObject({
            error: { code: "invalid_pairing_code" },
        });
        expect((await app.publish(pairing, runtimeCredential)).status).toBe(401);
    },
);

it("Given a revocation whose audit cannot commit, When it is retried, Then access remains until the complete revocation commits", async () => {
    const app = await project();
    const pairing = await app.pair("revoke-rollback");
    const claimed = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    await app.sql(`CREATE TRIGGER reject_revocation BEFORE INSERT ON runtime_pairing_audit_events
        WHEN NEW.action = 'runtime_pairing.revoked'
        BEGIN SELECT RAISE(ABORT, 'Controlled revocation failure'); END`);
    expect((await app.revoke(pairing)).status).toBe(500);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "paired" });
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(204);
    await app.sql("DROP TRIGGER reject_revocation");
    expect((await app.revoke(pairing)).status).toBe(204);
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(401);
    expect(await responseJson(await app.status(pairing), 200)).toEqual({
        status: "revoked",
        revokedAt: new Date().toISOString(),
    });
});

async function pairedChannelWithLegacyOwner() {
    const app = await project();
    const pairing = await app.pair("channel-access");
    const { runtimeCredential } = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    const hostToken = `${app.projectId}_${"H".repeat(43)}`;
    // Owner credentials issued before Runtime pairing remain valid channel callers.
    await app.storage(async (storage) => {
        new DurableObjectSqlDatabase(storage).orm
            .insert(channelHostCredential)
            .values({
                credentialId: "legacy-owner",
                channelId: pairing.channelId,
                tokenHash: await hashSecret(hostToken),
                authority: "owner",
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
            })
            .run();
    });
    const grant = async () =>
        v.parse(
            v.strictObject({ expiresAt: v.string(), grantId: v.string(), grantSecret: v.string() }),
            await responseJson(await app.createGrant(pairing, hostToken), 201),
        );
    return { app, pairing, hostToken, runtimeCredential, grant };
}

it("Given channel credentials and an unused access link, When their Runtime is revoked, Then access is denied without rewriting credential or grant facts", async () => {
    const { app, pairing, hostToken, runtimeCredential, grant } = await pairedChannelWithLegacyOwner();
    const used = await grant();
    const redemptions = await Promise.all([
        app.redeemGrant(pairing, used.grantId, used.grantSecret),
        app.redeemGrant(pairing, used.grantId, used.grantSecret),
    ]);
    redemptions.sort((left, right) => left.status - right.status);
    const [redeemed, repeated] = redemptions;
    if (redeemed === undefined || repeated === undefined) {
        throw new Error("Expected both redemption responses");
    }
    const linked = v.parse(
        v.strictObject({ hostToken: v.string(), channelId: v.string(), projectId: v.string() }),
        await responseJson(redeemed, 200),
    );
    expect(await responseJson(repeated, 409)).toMatchObject({ error: { code: "access_grant_redeemed" } });
    expect((await app.readChannel(pairing, linked.hostToken)).status).toBe(200);
    const unused = await grant();
    const facts = () =>
        app.storage((storage) => {
            const database = new DurableObjectSqlDatabase(storage).orm;
            return {
                hosts: database
                    .select({ id: channelHostCredential.credentialId, revokedAt: channelHostCredential.revokedAt })
                    .from(channelHostCredential)
                    .orderBy(channelHostCredential.credentialId)
                    .all(),
                grants: database.select().from(channelAccessGrant).orderBy(channelAccessGrant.grantId).all(),
            };
        });
    const before = await facts();
    expect((await app.revoke(pairing)).status).toBe(204);
    expect(await facts()).toEqual(before);
    await app.restart();
    expect((await app.publish(pairing, runtimeCredential)).status).toBe(401);
    expect((await app.readChannel(pairing, hostToken)).status).toBe(401);
    expect((await app.readChannel(pairing, linked.hostToken)).status).toBe(401);
    expect(await responseJson(await app.redeemGrant(pairing, used.grantId, used.grantSecret), 409)).toMatchObject({
        error: { code: "access_grant_redeemed" },
    });
    expect(await responseJson(await app.redeemGrant(pairing, unused.grantId, unused.grantSecret), 401)).toEqual({
        error: { code: "runtime_revoked", message: "The Runtime has been revoked" },
    });
    // Refusing a revoked Runtime must neither consume the link nor issue a credential.
    expect(await facts()).toEqual(before);
});

it("Given expired links and stored links shortened by an older revoker, When they are redeemed, Then genuine expiry and Runtime revocation remain distinguishable", async () => {
    const { app, pairing, grant } = await pairedChannelWithLegacyOwner();
    const expired = await grant();
    vi.setSystemTime(new Date(expired.expiresAt));
    expect(await responseJson(await app.redeemGrant(pairing, expired.grantId, expired.grantSecret), 410)).toMatchObject(
        {
            error: { code: "access_grant_expired" },
        },
    );
    const legacy = await grant();
    expect((await app.revoke(pairing)).status).toBe(204);
    // Retain the pre-fix writer's persisted representation. Its lost deadline
    // cannot be reconstructed, but the authoritative revocation is still known.
    await app.storage((storage) => {
        new DurableObjectSqlDatabase(storage).orm
            .update(channelAccessGrant)
            .set({ expiresAt: Date.now() })
            .where(eq(channelAccessGrant.grantId, legacy.grantId))
            .run();
    });
    await app.restart();
    expect(await responseJson(await app.redeemGrant(pairing, legacy.grantId, legacy.grantSecret), 401)).toEqual({
        error: { code: "runtime_revoked", message: "The Runtime has been revoked" },
    });
});

interface LegacyPairing {
    readonly pairing: Pairing;
    readonly key: string;
    readonly status: "pending" | "paired" | "expired" | "revoked";
    readonly daemonToken: string | null;
    readonly claimedAt: number | null;
    readonly revokedAt: number | null;
}

async function legacyDatabase(storage: DurableObjectStorage): Promise<DurableObjectSqlDatabase> {
    await storage.deleteAll();
    const database = new DurableObjectSqlDatabase(storage);
    database.run("CREATE TABLE project_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");
    for (const migration of projectDurableObjectMigrations) {
        if (migration.name === "0004_add_runtime_pairing_records.sql") {
            break;
        }
        database.run(migration.sql);
        database.run("INSERT INTO project_schema_migrations (name, applied_at) VALUES (?, ?)", [
            migration.name,
            Date.now(),
        ]);
    }
    return database;
}

async function insertLegacyPairing(
    database: DurableObjectSqlDatabase,
    row: LegacyPairing,
    ownerId: string,
    slot: number,
) {
    database.orm
        .insert(pairingChannel)
        .values({
            pairingId: row.pairing.pairingId,
            runtimeId: row.pairing.runtimeId,
            channelId: row.pairing.channelId,
            projectId: row.pairing.projectId,
            pairingCodeHash: await hashSecret(row.pairing.pairingCode),
            pollTokenHash: await hashSecret(row.pairing.pollToken),
            status: row.status,
            createdAt: Date.parse(row.pairing.expiresAt) - 600_000,
            expiresAt: Date.parse(row.pairing.expiresAt),
            creationIdempotencyKey: row.key,
            createdByOwnerCredentialId: ownerId,
            runtimeSlot: slot,
            daemonTokenHash: row.daemonToken === null ? null : await hashSecret(row.daemonToken),
            claimedAt: row.claimedAt,
            revokedAt: row.revokedAt,
            revokedByOwnerCredentialId: row.revokedAt === null ? null : ownerId,
            machineName: row.claimedAt === null ? "" : "Legacy machine",
            workspaceName: row.claimedAt === null ? "" : "Legacy workspace",
            agentsJson: "[]",
        })
        .run();
}

it("Given all legacy pairing lifecycles and existing credentials, When the Project upgrades and restarts, Then identities, deadlines, retries, and channel access are preserved", async () => {
    const app = await project();
    const now = Date.now();
    const pending = await app.pair("legacy-pending");
    const expired = { ...(await app.pair("legacy-expired")), expiresAt: new Date(now - 1).toISOString() };
    const overdue = { ...(await app.pair("legacy-overdue")), expiresAt: new Date(now - 1).toISOString() };
    const paired = { ...(await app.pair("legacy-paired")), expiresAt: new Date(now + 30_000).toISOString() };
    const revoked = await app.pair("legacy-revoked");
    const cancelled = await app.pair("legacy-cancelled");
    const daemonToken = `${app.projectId}_${"D".repeat(43)}`;
    const hostToken = "H".repeat(43);
    const rows: readonly LegacyPairing[] = [
        {
            pairing: pending,
            key: "legacy-pending",
            status: "pending",
            daemonToken: null,
            claimedAt: null,
            revokedAt: null,
        },
        {
            pairing: expired,
            key: "legacy-expired",
            status: "expired",
            daemonToken: null,
            claimedAt: null,
            revokedAt: null,
        },
        {
            pairing: overdue,
            key: "legacy-overdue",
            status: "pending",
            daemonToken: null,
            claimedAt: null,
            revokedAt: null,
        },
        {
            pairing: paired,
            key: "legacy-paired",
            status: "paired",
            daemonToken,
            claimedAt: now - 2_000,
            revokedAt: null,
        },
        {
            pairing: revoked,
            key: "legacy-revoked",
            status: "revoked",
            daemonToken: null,
            claimedAt: now - 2_000,
            revokedAt: now - 1_000,
        },
        {
            pairing: cancelled,
            key: "legacy-cancelled",
            status: "revoked",
            daemonToken: null,
            claimedAt: null,
            revokedAt: now - 1_000,
        },
    ];
    await app.storage(async (storage) => {
        const database = await legacyDatabase(storage);
        for (const [index, row] of rows.entries()) {
            await insertLegacyPairing(database, row, app.credentialId, index + 1);
        }
        database.orm
            .insert(channelHostCredential)
            .values({
                credentialId: "legacy-owner",
                channelId: paired.channelId,
                tokenHash: await hashSecret(hostToken),
                authority: "owner",
                createdAt: now - 2_000,
                lastUsedAt: now - 2_000,
            })
            .run();
        database.orm
            .insert(runtimePairingAuditEvent)
            .values({
                auditId: "legacy-expiry-audit",
                projectId: app.projectId,
                pairingId: expired.pairingId,
                runtimeId: expired.runtimeId,
                actorKind: "system",
                actorId: "relay",
                action: "runtime_pairing.expired",
                detailsJson: "{}",
                recordedAt: now - 1,
            })
            .run();
    });
    await app.restart();
    expect(await responseJson(await app.status(pending), 200)).toEqual({
        status: "pending",
        expiresAt: pending.expiresAt,
    });
    for (const pairing of [expired, overdue]) {
        expect(await responseJson(await app.status(pairing), 200)).toEqual({ status: "expired" });
        expect((await app.claim(pairing)).status).toBe(400);
    }
    expect(await responseJson(await app.status(paired), 200)).toMatchObject({
        status: "paired",
        runtimeId: paired.runtimeId,
        channelId: paired.channelId,
        machineName: "Legacy machine",
        agents: [],
    });
    for (const pairing of [revoked, cancelled]) {
        expect(await responseJson(await app.status(pairing), 200)).toEqual({
            status: "revoked",
            revokedAt: new Date(now - 1_000).toISOString(),
        });
        expect((await app.revoke(pairing)).status).toBe(204);
        expect((await app.claim(pairing)).status).toBe(400);
    }
    for (const row of rows) {
        expect(await app.pair(row.key)).toEqual(row.pairing);
    }
    expect((await app.publish(paired, daemonToken)).status).toBe(204);
    // An old random credential cannot be reconstructed. A replay must neither
    // replace it nor return a newly derived credential that cannot authenticate.
    expect(await responseJson(await app.claim(paired), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    vi.setSystemTime(new Date(paired.expiresAt));
    expect(await responseJson(await app.status(paired), 200)).toMatchObject({ status: "paired" });
    expect((await app.publish(paired, daemonToken)).status).toBe(204);
    expect(await responseJson(await app.readChannel(paired, hostToken), 200)).toMatchObject({
        runtimeId: paired.runtimeId,
    });
    const grant = v.parse(
        v.object({ grantId: v.string(), grantSecret: v.string() }),
        await responseJson(await app.createGrant(paired, hostToken), 201),
    );
    const linked = v.parse(
        v.object({ hostToken: v.string() }),
        await responseJson(await app.redeemGrant(paired, grant.grantId, grant.grantSecret), 200),
    );
    expect((await app.readChannel(paired, linked.hostToken)).status).toBe(200);
    expect((await app.revoke(paired)).status).toBe(204);
    expect((await app.publish(paired, daemonToken)).status).toBe(401);
    expect((await app.readChannel(paired, hostToken)).status).toBe(401);
    expect((await app.readChannel(paired, linked.hostToken)).status).toBe(401);
    const audit = await app.storage((storage) =>
        storage.sql
            .exec(
                "SELECT action, recorded_at FROM runtime_pairing_audit_events WHERE audit_id = ?",
                "legacy-expiry-audit",
            )
            .one(),
    );
    expect(audit).toEqual({ action: "runtime_pairing.expired", recorded_at: now - 1 });
    await app.restart();
    expect((await app.claim(pending)).status).toBe(200);
});

it("Given legacy records and an interrupted data copy, When migration retries, Then the original pairing and credential survive without a partial migration", async () => {
    const app = await project();
    const pairing = await app.pair("migration-retry");
    const daemonToken = `${app.projectId}_${"M".repeat(43)}`;
    await app.storage(async (storage) => {
        const database = await legacyDatabase(storage);
        await insertLegacyPairing(
            database,
            {
                pairing,
                key: "migration-retry",
                status: "paired",
                daemonToken,
                claimedAt: Date.now(),
                revokedAt: null,
            },
            app.credentialId,
            1,
        );
        const addition = projectDurableObjectMigrations.find(
            (migration) => migration.name === "0004_add_runtime_pairing_records.sql",
        );
        if (addition === undefined) {
            throw new Error("Expected the additive Runtime migration");
        }
        database.run(addition.sql);
        database.run("INSERT INTO project_schema_migrations (name, applied_at) VALUES (?, ?)", [
            addition.name,
            Date.now(),
        ]);
        database.run(`CREATE TRIGGER interrupt_runtime_copy BEFORE INSERT ON runtime_registrations
            BEGIN SELECT RAISE(ABORT, 'Controlled migration failure'); END`);
        expect(() => initializeProjectDurableObjectSchema(database)).toThrow("Controlled migration failure");
        expect(database.query("SELECT runtime_id FROM pairing_channels")).toEqual([{ runtime_id: pairing.runtimeId }]);
        expect(database.query("SELECT runtime_id FROM runtimes")).toEqual([]);
        database.run("DROP TRIGGER interrupt_runtime_copy");
        initializeProjectDurableObjectSchema(database);
    });
    await app.restart();
    expect(await app.pair("migration-retry")).toEqual(pairing);
    expect((await app.publish(pairing, daemonToken)).status).toBe(204);
});

it("Given one available Runtime place, When distinct requests compete, Then exactly one reserves it and retries keep the same identity", async () => {
    const app = await project();
    await Promise.all(
        Array.from({ length: MAX_RUNTIMES_PER_PROJECT - 1 }, (_, index) => app.pair(`existing-${index}`)),
    );
    const responses = await Promise.all([app.create("competitor-a"), app.create("competitor-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    const winnerIndex = responses.findIndex((response) => response.status === 201);
    const winner = responses[winnerIndex];
    if (winner === undefined) {
        throw new Error("Expected one successful reservation");
    }
    const pairing = v.parse(pairingSchema, await responseJson(winner, 201));
    const key = winnerIndex === 0 ? "competitor-a" : "competitor-b";
    expect(await app.pair(key)).toEqual(pairing);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
});

it("Given a pending pairing, When claims arrive concurrently, Then they return the same credential and its Runtime survives the handshake deadline", async () => {
    const app = await project();
    const pairing = await app.pair("claim-once");
    const responses = await Promise.all([app.claim(pairing), app.claim(pairing)]);
    const results = await Promise.all(responses.map((response) => responseJson(response, 200)));
    expect(results[0]).toEqual(results[1]);
    const { runtimeCredential } = v.parse(v.object({ runtimeCredential: v.string() }), results[0]);
    vi.setSystemTime(new Date(Date.parse(pairing.expiresAt) + 1));
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "paired", agents: [] });
    expect((await app.publish(pairing, runtimeCredential)).status).toBe(204);
    expect(await responseJson(await app.list(), 200)).toMatchObject({ runtimes: [{ runtimeId: pairing.runtimeId }] });
    expect((await app.revoke(pairing)).status).toBe(204);
    const revoked = await responseJson(await app.status(pairing), 200);
    expect(revoked).toEqual({ status: "revoked", revokedAt: new Date().toISOString() });
    vi.setSystemTime(new Date(Date.now() + 1_000));
    expect((await app.revoke(pairing)).status).toBe(204);
    expect(await responseJson(await app.status(pairing), 200)).toEqual(revoked);
    expect(await responseJson(await app.publish(pairing, runtimeCredential), 401)).toMatchObject({
        error: { code: "unauthorized" },
    });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
    expect(await app.pair("claim-once")).toEqual(pairing);
});

it("Given an unclaimed Runtime identity, When it is revoked, Then its code cannot claim it and revocation remains visible after expiry", async () => {
    const app = await project();
    const pairing = await app.pair("cancel-before-claim");
    expect((await app.revoke(pairing)).status).toBe(204);
    const revoked = await responseJson(await app.status(pairing), 200);
    expect(revoked).toMatchObject({ status: "revoked" });
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    vi.setSystemTime(new Date(pairing.expiresAt));
    expect(await responseJson(await app.status(pairing), 200)).toEqual(revoked);
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
});

it("Given separate Projects, When they use the same pairing idempotency key, Then each receives its own stable Runtime identity", async () => {
    const first = await project();
    const second = await project("Another Runtime pairing App");
    const left = await first.pair("same-key");
    const right = await second.pair("same-key");
    expect(left.runtimeId).not.toBe(right.runtimeId);
    expect(await first.pair("same-key")).toEqual(left);
    expect(await second.pair("same-key")).toEqual(right);
});
