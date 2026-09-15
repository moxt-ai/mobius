import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPlatformGateways } from "../packages/relay-cloudflare-platform/src/worker.ts";
import { StandaloneProjectStorageDirectory } from "../packages/relay-cloudflare-standalone/src/project-storage-directory.ts";
import { D1DatabaseAdapter } from "../packages/relay-core/src/infra/d1-database.ts";
import { createTestAgent } from "./infra/agent.ts";
import { createTestMobiusApp, createTestMobiusPlatformApp } from "./infra/app.ts";
import { createTestMobiusBindings, createTestMobiusPlatformBindings } from "./infra/cloudflare.ts";
import { createTestGateways } from "./infra/gateways.ts";
import { TestDeveloperAuthenticator } from "./infra/identity.ts";
import { createTestRuntime } from "./infra/runtime.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
});

it("Given a Platform Project, When its owner pairs a local Runtime, Then that Project exposes the connected Runtime and Agent", async () => {
    const signal = AbortSignal.timeout(10_000);
    await using bindings = await createTestMobiusPlatformBindings();
    const app = createTestMobiusPlatformApp(
        {
            bindings: bindings.env,
            developerAuthenticator: new TestDeveloperAuthenticator(),
            operatorSubjects: new Set(["developer-1"]),
            allowedOrigins: new Set(),
        },
        createPlatformGateways,
    );
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: "http://platform.test",
        authenticationProviderId: "clerk",
        credentialProvider: new MobiusOidcCredentialProvider("developer-token"),
        transport: { fetch: async (request) => await app.request(request) },
    });
    const tenant = (await developer.listTenants(signal))[0];
    if (tenant === undefined) {
        throw new Error("Missing organization");
    }
    const application = await developer.createApp(tenant.tenantId, "Runtime test", signal);
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
});
afterEach(() => vi.useRealTimers());

it("Given a local Agent, When its Runtime pairs and connects, Then its Project owner sees that Runtime and Agent online", async () => {
    const signal = AbortSignal.timeout(10_000);
    await using bindings = await createTestMobiusBindings();
    await using gateways = createTestGateways({
        databases: { resolve: () => D1DatabaseAdapter.from(bindings.env.DIRECTORY_DATABASE) },
        projects: new StandaloneProjectStorageDirectory(),
        signal,
    });
    const app = createTestMobiusApp({ bindings: bindings.env }, () => gateways);
    await using agent = await createTestAgent({ signal });
    await using runtime = await createTestRuntime({ server: app, agent, signal });

    const runtimes = await runtime.client.runtimes.list(signal);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({ runtimeId: runtime.runtimeId, online: true, agents: [{ id: "codex" }] });
    const session = await runtime.client.sessions.create(
        {
            agentId: "codex",
            bindingId: "workspace",
            directoryId: "default",
            policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
            runtimeId: runtime.runtimeId,
            sessionId: "runtime-chat",
            title: "Runtime chat",
        },
        signal,
    );
    const completed = Promise.withResolvers<string>();
    const subscription = await runtime.client.events.subscribe(
        session.sessionId,
        "",
        {
            receive: async (event) => {
                if (event.payload.kind === "session.completed" || event.payload.kind === "session.failed") {
                    completed.resolve(event.payload.kind);
                }
                return true;
            },
        },
        signal,
    );
    try {
        await runtime.client.turns.submit(
            session.sessionId,
            {
                additionalDirectoryIds: [],
                artifactIds: [],
                content: "Hello",
                idempotencyKey: "greeting",
                images: [],
                resources: [],
            },
            signal,
        );
        expect(await Promise.race([completed.promise, subscription.completed])).toBe("session.completed");
    } finally {
        subscription.close();
        await subscription.completed;
    }
});
