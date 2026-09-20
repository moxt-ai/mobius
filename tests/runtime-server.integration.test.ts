import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";
import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPlatformGateways } from "../packages/relay-cloudflare-platform/src/worker.ts";
import { createTestAgent } from "./infra/agent.ts";
import { createTestMobiusPlatformApp } from "./infra/app.ts";
import { FakeClerk } from "./infra/clerk.ts";
import { createTestMobiusPlatformBindings } from "./infra/cloudflare.ts";
import { createTestRuntime } from "./infra/runtime.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
});

it("Given a Platform Project, When its owner pairs a local Runtime and creates a Session, Then the Project Durable Object accepts the Session", async () => {
    const signal = AbortSignal.timeout(10_000);
    await using bindings = await createTestMobiusPlatformBindings();
    const clerk = new FakeClerk();
    const app = createTestMobiusPlatformApp(
        {
            bindings: bindings.env,
            developerAuthenticator: clerk.authenticator,
            operatorSubjects: new Set(["developer-1"]),
            allowedOrigins: new Set(),
        },
        createPlatformGateways,
    );
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: "http://platform.test",
        authenticationProviderId: "clerk",
        credentialProvider: new MobiusOidcCredentialProvider(clerk.session("developer-1", clerk.defaultOrganizationId)),
        transport: { fetch: async (request) => await app.request(request) },
    });
    const tenant = (await developer.listTenants(signal))[0];
    if (tenant === undefined) {
        throw new Error("Missing organization");
    }
    const application = await developer.createApp(tenant.tenantId, "Runtime test", signal, true);
    const project = await developer.createProject(
        application.appId,
        {
            clientReference: "runtime-test",
            displayName: "Runtime test",
            idempotencyKey: "runtime-test",
            locationHint: "apac",
        },
        signal,
    );
    await using agent = await createTestAgent({ signal });
    await using runtime = await createTestRuntime({
        server: app,
        agent,
        signal,
        project: { projectId: project.projectId, credential: application.defaultCredential.credential },
    });
    expect(await runtime.client.runtimes.list(signal)).toMatchObject([
        { runtimeId: runtime.runtimeId, projectId: project.projectId, online: true, agents: [{ id: "codex" }] },
    ]);
    const sessionId = `moxt-session:${"a".repeat(64)}`;
    const bindingId = `moxt-session-binding:${"b".repeat(64)}`;
    await expect(
        runtime.client.sessions.create(
            {
                agentId: "codex",
                bindingId,
                directoryId: "root",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: runtime.runtimeId,
                sessionId,
                title: "Moxt local Agent Session",
            },
            signal,
        ),
    ).resolves.toMatchObject({
        defaultBinding: { bindingId, sessionId },
        sessionId,
    });
});
afterEach(() => vi.useRealTimers());
