import { env, exports } from "cloudflare:workers";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core";
import {
    ExchangingMobiusCredentialProvider,
    MobiusBotOwnerClient,
    MobiusProjectAuthenticationClient,
    RotatingMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneWorker, type RelayBindings, StandaloneAuthenticationConfiguration } from "../src/worker.ts";

const relayOrigin = "https://relay.test";
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

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.fromEntries(Object.entries(value));
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

async function responseRecord(response: Response, status: number): Promise<Readonly<Record<string, unknown>>> {
    const detail = response.status === status ? "" : await response.clone().text();
    expect(response.status, detail).toBe(status);
    return record(await response.json());
}

function authorization(token: string): HeadersInit {
    return { authorization: `Bearer ${token}` };
}

function bootstrapEnvironment(enabled: boolean, clientLimit: number, tenantLimit: number): RelayBindings {
    const tenantId = env.MOBIUS_TENANT_ID;
    if (tenantId === undefined) {
        throw new Error("Expected the standalone tenant binding");
    }
    return {
        BOT_CONNECTIONS: env.BOT_CONNECTIONS,
        DIRECTORY_DATABASE: env.DIRECTORY_DATABASE,
        MOBIUS_TENANT_ID: tenantId,
        PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT: clientLimit.toString(),
        PUBLIC_PROJECT_BOOTSTRAP_ENABLED: enabled.toString(),
        PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT: tenantLimit.toString(),
        PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS: "60",
        RUNTIME_RELAY: env.RUNTIME_RELAY,
        SESSION_ARCHIVE_BYTES_PER_SESSION: env.SESSION_ARCHIVE_BYTES_PER_SESSION,
        SESSION_RELAY: env.SESSION_RELAY,
    };
}

class StatefulExternalIdentityAuthenticator implements ExternalIdentityAuthenticator {
    #available = true;

    readonly fail = (): void => {
        this.#available = false;
    };

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        if (!this.#available) {
            throw new ProjectAuthenticationError(
                "external_provider_unavailable",
                "The external identity provider is unavailable",
            );
        }
        if (credential.providerId !== "clerk") {
            throw new ProjectAuthenticationError("external_provider_invalid", "The external provider is invalid");
        }
        const subject = credential.credential === "unbound-proof" ? "user_unbound" : "user_bound";
        return new VerifiedExternalIdentity(
            "clerk",
            "https://identity.example.test",
            subject,
            new Map([["email", `${subject}@example.test`]]),
            Date.now(),
            Date.now() + 10 * 60 * 1_000,
        );
    };
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    await env.DIRECTORY_DATABASE.prepare("DELETE FROM public_project_bootstrap_events").run();
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Project authentication", () => {
    it("Given public accountless bootstrap limits and an operator disable switch, When clients create Projects, Then limits are atomic, recover after the window, and disabled deployments reject bootstrap", async () => {
        const provider = new StatefulExternalIdentityAuthenticator();
        const limited = createStandaloneWorker(new StandaloneAuthenticationConfiguration(provider));
        const limitedEnvironment = bootstrapEnvironment(true, 1, 2);
        const bootstrap = async (clientAddress: string): Promise<Response> =>
            await limited.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, {
                    headers: { "cf-connecting-ip": clientAddress },
                    method: "POST",
                }),
                limitedEnvironment,
            );

        expect((await bootstrap("192.0.2.10")).status).toBe(201);
        const sameClient = await bootstrap("192.0.2.10");
        expect(sameClient.status).toBe(429);
        await expect(sameClient.json()).resolves.toMatchObject({
            error: { code: "public_project_bootstrap_rate_limited" },
        });
        expect((await bootstrap("192.0.2.11")).status).toBe(201);
        const tenantLimit = await bootstrap("192.0.2.12");
        expect(tenantLimit.status).toBe(429);

        vi.setSystemTime(Date.now() + 60_001);
        expect((await bootstrap("192.0.2.10")).status).toBe(201);

        const defensive = createStandaloneWorker(new StandaloneAuthenticationConfiguration(provider));
        const defensiveEnvironment = bootstrapEnvironment(true, 1, 100);
        const invalidAddressBootstrap = async (clientAddress: string): Promise<Response> =>
            await defensive.fetch(
                new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, {
                    headers: { "cf-connecting-ip": clientAddress },
                    method: "POST",
                }),
                defensiveEnvironment,
            );
        expect((await invalidAddressBootstrap("forged-client-a")).status).toBe(201);
        expect((await invalidAddressBootstrap("forged-client-b")).status).toBe(429);

        const disabled = createStandaloneWorker(new StandaloneAuthenticationConfiguration(provider));
        const disabledResponse = await disabled.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, {
                headers: { "cf-connecting-ip": "192.0.2.20" },
                method: "POST",
            }),
            bootstrapEnvironment(false, 1, 1),
        );
        expect(disabledResponse.status).toBe(403);
        await expect(disabledResponse.json()).resolves.toMatchObject({
            error: { code: "public_project_bootstrap_disabled" },
        });
    });

    it("Given accountless and application access in one deployment, When each credential uses its granted Project operations, Then both share Project authorization while application and Runtime authority stay isolated", async () => {
        const pairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const channelId = stringField(pairing, "channelId");
        const ownerCredential = stringField(pairing, "hostToken");

        const bot = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                body: JSON.stringify({ avatarRef: "", description: "", displayName: "Owner Bot" }),
                headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                method: "POST",
            }),
            201,
        );

        const application = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/applications`, {
                body: JSON.stringify({ name: "moxt-event-projector", permissions: ["bot:read"] }),
                headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                method: "POST",
            }),
            201,
        );
        const applicationId = stringField(application, "applicationId");
        const issued = await responseRecord(
            await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/project-applications/${applicationId}/credentials`,
                {
                    body: JSON.stringify({ expiresInSeconds: 3_600 }),
                    headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                    method: "POST",
                },
            ),
            201,
        );
        const applicationCredential = stringField(issued, "credential");

        const listed = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(applicationCredential),
            }),
            200,
        );
        expect(listed).toMatchObject({ bots: [{ botId: stringField(bot, "botId"), displayName: "Owner Bot" }] });
        const applicationClient = new MobiusBotOwnerClient({
            actorReference: "sdk-reader",
            credentialProvider: new RotatingMobiusCredentialProvider(applicationCredential),
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        expect(await applicationClient.listBots(new AbortController().signal)).toMatchObject({
            bots: [{ botId: stringField(bot, "botId"), displayName: "Owner Bot" }],
        });

        const browserCredential = await responseRecord(
            await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${projectId}/browser-credentials`,
                {
                    body: JSON.stringify({ expiresInSeconds: 300 }),
                    headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                    method: "POST",
                },
            ),
            201,
        );
        const browserListed = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(stringField(browserCredential, "token")),
            }),
            200,
        );
        expect(browserListed).toMatchObject({ bots: [{ botId: stringField(bot, "botId") }] });

        const deniedWrite = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`,
            {
                body: JSON.stringify({ avatarRef: "", description: "", displayName: "Forbidden Bot" }),
                headers: {
                    ...authorization(applicationCredential),
                    "content-type": "application/json",
                    "x-mobius-actor-ref": "  claimed-owner   from-moxt  ",
                },
                method: "POST",
            },
        );
        expect(deniedWrite.status).toBe(403);
        await expect(deniedWrite.json()).resolves.toMatchObject({ error: { code: "project_permission_denied" } });

        const audit = await responseRecord(
            await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/authentication-audit-events`,
                { headers: authorization(ownerCredential) },
            ),
            200,
        );
        expect(audit).toMatchObject({
            events: expect.arrayContaining([
                expect.objectContaining({
                    actorKind: "application",
                    actorRef: "claimed-owner from-moxt",
                    outcome: "denied",
                }),
                expect.objectContaining({ actorKind: "application", actorRef: "sdk-reader", outcome: "succeeded" }),
                expect.objectContaining({ actorKind: "browser_access", outcome: "succeeded" }),
            ]),
        });

        const runtimePlane = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${channelId}/daemon?token=${encodeURIComponent(applicationCredential)}`,
            { headers: { upgrade: "websocket" } },
        );
        expect(runtimePlane.status).toBe(401);
    });

    it("Given two least-privilege applications, When one credential rotates and is revoked, Then overlap is bounded and the other application remains authorized", async () => {
        const pairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const ownerCredential = stringField(pairing, "hostToken");
        const ownerProvider = new RotatingMobiusCredentialProvider(ownerCredential);
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: ownerProvider,
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        const signal = new AbortController().signal;
        const readerApplication = await client.applications.create(
            { name: "reader-to-rotate", permissions: ["bot:read"] },
            signal,
        );
        const independentApplication = await client.applications.create(
            { name: "independent-reader", permissions: ["bot:read"] },
            signal,
        );
        const concurrentlyRotatedApplication = await client.applications.create(
            { name: "concurrently-rotated-reader", permissions: ["bot:read"] },
            signal,
        );
        const original = await client.applicationCredentials.issue(
            readerApplication.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const independent = await client.applicationCredentials.issue(
            independentApplication.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const concurrentlyRotated = await client.applicationCredentials.issue(
            concurrentlyRotatedApplication.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const rotateConcurrently = async (): Promise<Response> =>
            await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/project-application-credentials/${concurrentlyRotated.credentialId}/rotate`,
                {
                    body: JSON.stringify({ expiresInSeconds: 3_600, overlapSeconds: 60 }),
                    headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                    method: "POST",
                },
            );
        const concurrentResponses = await Promise.all([rotateConcurrently(), rotateConcurrently()]);
        expect(concurrentResponses.map((response) => response.status).sort()).toEqual([201, 409]);
        const applicationsAfterConcurrentRotation = await client.applications.list(signal);
        const applicationAfterConcurrentRotation = applicationsAfterConcurrentRotation.find(
            (candidate) => candidate.applicationId === concurrentlyRotatedApplication.applicationId,
        );
        expect(applicationAfterConcurrentRotation?.credentials).toHaveLength(2);
        const originalCredential = original.credential;
        const rotated = await client.applicationCredentials.rotate(
            original.credentialId,
            { expiresInSeconds: 3_600, overlapSeconds: 60 },
            signal,
        );
        const rotatedCredential = rotated.credential;
        expect(rotated).toMatchObject({
            overlapEndsAt: new Date(Date.now() + 60_000).toISOString(),
            replacedCredentialId: original.credentialId,
        });
        const listBots = async (credential: string): Promise<Response> =>
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(credential),
            });
        expect((await listBots(originalCredential)).status).toBe(200);
        expect((await listBots(rotatedCredential)).status).toBe(200);

        vi.setSystemTime(Date.now() + 60_001);
        const overlapEnded = await listBots(originalCredential);
        expect(overlapEnded.status).toBe(401);
        await expect(overlapEnded.json()).resolves.toMatchObject({ error: { code: "credential_revoked" } });
        expect((await listBots(rotatedCredential)).status).toBe(200);

        await client.applicationCredentials.revoke(rotated.credentialId, signal);
        expect((await listBots(rotatedCredential)).status).toBe(401);
        expect((await listBots(independent.credential)).status).toBe(200);
    });

    it("Given an application has expiring credentials, When it is used, expires, and is revoked, Then last-used and lifecycle state stay observable and enforceable", async () => {
        const pairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const ownerCredential = stringField(pairing, "hostToken");
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: new RotatingMobiusCredentialProvider(ownerCredential),
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        const signal = new AbortController().signal;
        const application = await client.applications.create(
            { name: "lifecycle-reader", permissions: ["bot:read"] },
            signal,
        );
        const active = await client.applicationCredentials.issue(
            application.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const expiringApplication = await client.applications.create(
            { name: "expiring-reader", permissions: ["bot:read"] },
            signal,
        );
        const expiring = await client.applicationCredentials.issue(
            expiringApplication.applicationId,
            { expiresInSeconds: 60 },
            signal,
        );
        const listBots = async (credential: string): Promise<Response> =>
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(credential),
            });

        vi.setSystemTime(Date.now() + 5_000);
        expect((await listBots(active.credential)).status).toBe(200);
        const afterUse = await client.applications.list(signal);
        const activeAfterUse = afterUse.find((candidate) => candidate.applicationId === application.applicationId);
        expect(activeAfterUse?.credentials[0]?.lastUsedAt).toBe(new Date(Date.now()).toISOString());

        vi.setSystemTime(Date.now() + 55_001);
        const expired = await listBots(expiring.credential);
        expect(expired.status).toBe(401);
        await expect(expired.json()).resolves.toMatchObject({ error: { code: "credential_expired" } });

        await client.applications.revoke(application.applicationId, signal);
        const revoked = await listBots(active.credential);
        expect(revoked.status).toBe(401);
        await expect(revoked.json()).resolves.toMatchObject({ error: { code: "credential_revoked" } });
        const afterRevocation = await client.applications.list(signal);
        const revokedApplication = afterRevocation.find(
            (candidate) => candidate.applicationId === application.applicationId,
        );
        expect(revokedApplication?.state.lifecycle.value).toBe("revoked");
        expect(revokedApplication?.credentials[0]?.state.lifecycle.value).toBe("revoked");
        const audit = await client.auditEvents.list(100, signal);
        expect(audit).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    action: "project-application-credential.issued",
                    subjectId: active.credentialId,
                }),
                expect.objectContaining({
                    action: "project-application.revoked",
                    subjectId: application.applicationId,
                }),
            ]),
        );
    });

    it("Given two Projects, When one owner names the other Project's application or owner credential, Then every revocation stays inside its authorized Project", async () => {
        const firstPairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const secondPairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const firstOwnerCredential = stringField(firstPairing, "hostToken");
        const secondOwnerCredential = stringField(secondPairing, "hostToken");
        const secondProjectId = stringField(secondPairing, "projectId");
        const secondClient = new MobiusProjectAuthenticationClient({
            credentialProvider: new RotatingMobiusCredentialProvider(secondOwnerCredential),
            endpoint: relayOrigin,
            projectId: secondProjectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        const signal = new AbortController().signal;
        const secondApplication = await secondClient.applications.create(
            { name: "second-project-reader", permissions: ["bot:read"] },
            signal,
        );
        const secondApplicationCredential = await secondClient.applicationCredentials.issue(
            secondApplication.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const secondOwnerDirectory = await secondClient.ownerCredentials.list(signal);
        const secondOwner = secondOwnerDirectory.credentials[0];
        if (secondOwner === undefined) {
            throw new Error("Expected the second Project owner credential");
        }
        const crossProjectPost = async (path: string): Promise<Response> =>
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/${path}`, {
                body: "{}",
                headers: { ...authorization(firstOwnerCredential), "content-type": "application/json" },
                method: "POST",
            });

        expect(
            (
                await crossProjectPost(
                    `v1/project-application-credentials/${secondApplicationCredential.credentialId}/revoke`,
                )
            ).status,
        ).toBe(404);
        expect(
            (await crossProjectPost(`v1/project-applications/${secondApplication.applicationId}/revoke`)).status,
        ).toBe(404);
        expect((await crossProjectPost(`v1/project-owner-credentials/${secondOwner.credentialId}/revoke`)).status).toBe(
            404,
        );

        const applicationStillAuthorized = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${secondProjectId}/bots`,
            { headers: authorization(secondApplicationCredential.credential) },
        );
        expect(applicationStillAuthorized.status, await applicationStillAuthorized.clone().text()).toBe(200);
        const ownerStillAuthorized = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${secondProjectId}/bots`,
            { headers: authorization(secondOwnerCredential) },
        );
        expect(ownerStillAuthorized.status, await ownerStillAuthorized.clone().text()).toBe(200);
    });

    it("Given an accountless owner credential, When the SDK rotates and revokes it, Then Project and Host access share the overlap window and recovery risk stays explicit", async () => {
        const pairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const channelId = stringField(pairing, "channelId");
        const originalCredential = stringField(pairing, "hostToken");
        await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
                body: JSON.stringify({
                    agents: readyAgents,
                    installableAgents: [],
                    machineName: "owner-rotation-runtime",
                    pairingCode: stringField(pairing, "pairingCode"),
                    workspaceName: "owner-rotation-workspace",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            200,
        );
        const provider = new RotatingMobiusCredentialProvider(originalCredential);
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: provider,
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        const signal = new AbortController().signal;
        const directory = await client.ownerCredentials.list(signal);
        const original = directory.credentials[0];
        if (original === undefined) {
            throw new Error("Expected the accountless owner credential");
        }
        expect(directory.recoveryWarning).toContain("not recoverable");

        const rotated = await client.ownerCredentials.rotate(original.credentialId, { overlapSeconds: 60 }, signal);
        provider.replace(rotated);
        const readChannel = async (credential: string): Promise<Response> =>
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/channels/${channelId}`, {
                headers: authorization(credential),
            });
        const originalDuringOverlap = await readChannel(originalCredential);
        expect(originalDuringOverlap.status, await originalDuringOverlap.clone().text()).toBe(200);
        expect((await readChannel(rotated.credential)).status).toBe(200);

        vi.setSystemTime(Date.now() + 60_001);
        expect((await readChannel(originalCredential)).status).toBe(401);
        const expiredProjectCredential = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`,
            { headers: authorization(originalCredential) },
        );
        expect(expiredProjectCredential.status).toBe(401);
        await expect(expiredProjectCredential.json()).resolves.toMatchObject({
            error: { code: "credential_revoked" },
        });
        expect((await readChannel(rotated.credential)).status).toBe(200);

        await client.ownerCredentials.revoke(rotated.credentialId, signal);
        expect((await readChannel(rotated.credential)).status).toBe(401);
    });

    it("Given the bootstrap Runtime was revoked, When its accountless owner rotates, Then Project authority remains independently recoverable", async () => {
        const pairing = await responseRecord(
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const runtimeId = stringField(pairing, "runtimeId");
        const originalCredential = stringField(pairing, "hostToken");
        const runtimeRevocation = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${projectId}/runtimes/${runtimeId}`,
            { headers: authorization(originalCredential), method: "DELETE" },
        );
        expect(runtimeRevocation.status, await runtimeRevocation.clone().text()).toBe(204);

        const provider = new RotatingMobiusCredentialProvider(originalCredential);
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: provider,
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await exports.default.fetch(request) },
        });
        const signal = new AbortController().signal;
        const directory = await client.ownerCredentials.list(signal);
        const current = directory.credentials[0];
        if (current === undefined) {
            throw new Error("Expected the accountless owner credential");
        }
        const replacement = await client.ownerCredentials.rotate(current.credentialId, { overlapSeconds: 60 }, signal);
        provider.replace(replacement);
        const projectRead = async (credential: string): Promise<Response> =>
            await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(credential),
            });
        expect((await projectRead(originalCredential)).status).toBe(200);
        expect((await projectRead(replacement.credential)).status).toBe(200);

        vi.setSystemTime(Date.now() + 60_001);
        expect((await projectRead(originalCredential)).status).toBe(401);
        expect((await projectRead(replacement.credential)).status).toBe(200);
    });

    it("Given an accountless Project and a configured external provider, When the owner attaches and then revokes its capability, Then short-lived external access keeps the same resources and provider outages stay isolated", async () => {
        const provider = new StatefulExternalIdentityAuthenticator();
        const worker = createStandaloneWorker(new StandaloneAuthenticationConfiguration(provider));
        const fetch = async (path: string, init: RequestInit = {}): Promise<Response> =>
            await worker.fetch(new Request(`${relayOrigin}${path}`, init), env);
        const pairing = await responseRecord(await fetch(`${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }), 201);
        const projectId = stringField(pairing, "projectId");
        const runtimeId = stringField(pairing, "runtimeId");
        const ownerCredential = stringField(pairing, "hostToken");
        const bot = await responseRecord(
            await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                body: JSON.stringify({ avatarRef: "", description: "", displayName: "Preserved Bot" }),
                headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                method: "POST",
            }),
            201,
        );

        const ownerProvider = new RotatingMobiusCredentialProvider(ownerCredential);
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: ownerProvider,
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await worker.fetch(request, env) },
        });
        const signal = new AbortController().signal;
        const application = await client.applications.create(
            { name: "coexisting-reader", permissions: ["bot:read", "project:read"] },
            signal,
        );
        const applicationCredential = await client.applicationCredentials.issue(
            application.applicationId,
            { expiresInSeconds: 3_600 },
            signal,
        );
        const runtimeRevocation = await fetch(`${MOBIUS_API_PREFIX}/projects/${projectId}/runtimes/${runtimeId}`, {
            headers: authorization(ownerCredential),
            method: "DELETE",
        });
        expect(runtimeRevocation.status, await runtimeRevocation.clone().text()).toBe(204);
        const attached = await client.externalIdentityBindings.attach(
            {
                externalCredential: "fresh-owner-proof",
                permissions: ["bot:read", "project:read"],
                providerId: "clerk",
                revokeOwnerCredential: true,
            },
            signal,
        );
        expect(attached).toMatchObject({ ownerCredentialRevoked: true, projectId, subject: "user_bound" });

        const externalProvider = new RotatingMobiusCredentialProvider("fresh-exchange-proof");
        const accessProvider = new ExchangingMobiusCredentialProvider(client, "clerk", externalProvider, 300);
        const accessCredential = await accessProvider.credential(signal);

        const ownerRejected = await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
            headers: authorization(ownerCredential),
        });
        expect(ownerRejected.status).toBe(401);
        await expect(ownerRejected.json()).resolves.toMatchObject({ error: { code: "credential_revoked" } });
        const preserved = await responseRecord(
            await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(accessCredential),
            }),
            200,
        );
        expect(preserved).toMatchObject({ bots: [{ botId: stringField(bot, "botId"), displayName: "Preserved Bot" }] });

        const unbound = await fetch(`${MOBIUS_API_PREFIX}/v1/auth/exchanges/clerk`, {
            body: JSON.stringify({ expiresInSeconds: 300, projectId }),
            headers: { authorization: "Bearer unbound-proof", "content-type": "application/json" },
            method: "POST",
        });
        expect(unbound.status).toBe(403);
        await expect(unbound.json()).resolves.toMatchObject({ error: { code: "external_identity_not_granted" } });

        provider.fail();
        expect(
            (
                await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                    headers: authorization(accessCredential),
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                    headers: authorization(applicationCredential.credential),
                })
            ).status,
        ).toBe(200);
        const unavailableExchange = await fetch(`${MOBIUS_API_PREFIX}/v1/auth/exchanges/clerk`, {
            body: JSON.stringify({ expiresInSeconds: 300, projectId }),
            headers: { authorization: "Bearer fresh-exchange-proof", "content-type": "application/json" },
            method: "POST",
        });
        expect(unavailableExchange.status).toBe(503);
        await expect(unavailableExchange.json()).resolves.toMatchObject({
            error: { code: "external_provider_unavailable" },
        });
    });

    it("Given an attached external identity has issued access, When its Project grant is revoked, Then old and new external access fail without affecting the owner", async () => {
        const provider = new StatefulExternalIdentityAuthenticator();
        const worker = createStandaloneWorker(new StandaloneAuthenticationConfiguration(provider));
        const fetch = async (path: string, init: RequestInit = {}): Promise<Response> =>
            await worker.fetch(new Request(`${relayOrigin}${path}`, init), env);
        const pairing = await responseRecord(await fetch(`${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }), 201);
        const projectId = stringField(pairing, "projectId");
        const ownerCredential = stringField(pairing, "hostToken");
        const client = new MobiusProjectAuthenticationClient({
            credentialProvider: new RotatingMobiusCredentialProvider(ownerCredential),
            endpoint: relayOrigin,
            projectId,
            transport: { fetch: async (request) => await worker.fetch(request, env) },
        });
        const signal = new AbortController().signal;
        const binding = await client.externalIdentityBindings.attach(
            {
                externalCredential: "fresh-owner-proof",
                permissions: ["bot:read"],
                providerId: "clerk",
                revokeOwnerCredential: false,
            },
            signal,
        );
        const access = await client.exchangeExternalIdentity(
            { expiresInSeconds: 300, providerId: "clerk" },
            new RotatingMobiusCredentialProvider("fresh-exchange-proof"),
            signal,
        );
        const listBots = async (credential: string): Promise<Response> =>
            await fetch(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/bots`, {
                headers: authorization(credential),
            });
        expect((await listBots(access.credential)).status).toBe(200);

        const duplicateAttachment = await fetch(
            `${MOBIUS_API_PREFIX}/v1/projects/${projectId}/external-identity-bindings`,
            {
                body: JSON.stringify({
                    externalCredential: "fresh-owner-proof",
                    permissions: ["bot:read"],
                    providerId: "clerk",
                    revokeOwnerCredential: true,
                }),
                headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(duplicateAttachment.status).toBe(409);
        await expect(duplicateAttachment.json()).resolves.toMatchObject({
            error: { code: "external_identity_binding_conflict" },
        });
        expect((await listBots(ownerCredential)).status).toBe(200);

        await client.externalIdentityBindings.revoke(binding.bindingId, signal);
        expect(await client.externalIdentityBindings.list(signal)).toHaveLength(0);
        const revokedAccess = await listBots(access.credential);
        expect(revokedAccess.status).toBe(401);
        await expect(revokedAccess.json()).resolves.toMatchObject({ error: { code: "credential_revoked" } });
        const newExchange = await fetch(`${MOBIUS_API_PREFIX}/v1/auth/exchanges/clerk`, {
            body: JSON.stringify({ expiresInSeconds: 300, projectId }),
            headers: { authorization: "Bearer fresh-exchange-proof", "content-type": "application/json" },
            method: "POST",
        });
        expect(newExchange.status).toBe(403);
        await expect(newExchange.json()).resolves.toMatchObject({
            error: { code: "external_identity_not_granted" },
        });
        expect((await listBots(ownerCredential)).status).toBe(200);
    });
});
