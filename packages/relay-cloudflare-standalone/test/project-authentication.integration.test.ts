import { env } from "cloudflare:workers";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusApp } from "../../../tests/infra/app.ts";
import type { RelayBindings } from "../src/worker.ts";
import { createStandaloneGateways } from "../src/worker.ts";
import { testBindings } from "./infra/bindings.ts";

const relayOrigin = "https://relay.test";
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

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    await env.DIRECTORY_DATABASE.prepare("DELETE FROM public_project_bootstrap_events").run();
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Project authentication", () => {
    it("Given a Standalone deployment, When Platform application or external-login routes are requested, Then those trust planes are not mounted", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await responseRecord(
            await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST" }),
            201,
        );
        const projectId = stringField(pairing, "projectId");
        const ownerCredential = stringField(pairing, "hostToken");
        const application = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/applications`,
            {
                body: JSON.stringify({ name: "must-not-exist", permissions: ["bot:read"] }),
                headers: { ...authorization(ownerCredential), "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(application.status).toBe(404);
        const exchange = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/auth/exchanges/clerk`, {
            body: JSON.stringify({ expiresInSeconds: 300, projectId }),
            headers: { authorization: "Bearer external-proof", "content-type": "application/json" },
            method: "POST",
        });
        expect(exchange.status).toBe(404);
        const ownerCredentials = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/owner-credentials`,
            { headers: authorization(ownerCredential) },
        );
        expect(ownerCredentials.status).toBe(404);
        const auditEvents = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/authentication-audit-events`,
            { headers: authorization(ownerCredential) },
        );
        expect(auditEvents.status).toBe(404);
    });

    it("Given public accountless bootstrap limits and an operator disable switch, When clients create Projects, Then limits are atomic, recover after the window, and disabled deployments reject bootstrap", async () => {
        const limited = createTestMobiusApp({}, createStandaloneGateways);
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

        const defensive = createTestMobiusApp({}, createStandaloneGateways);
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

        const disabled = createTestMobiusApp({}, createStandaloneGateways);
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
});
