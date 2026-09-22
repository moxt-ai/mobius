import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startTestPlatform } from "./infra/platform.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
});

it("Given a Platform Project, When its owner pairs a local Runtime and creates a Session, Then the Project Durable Object accepts the Session", async () => {
    const signal = AbortSignal.timeout(10_000);
    await using platform = await startTestPlatform();
    const project = await platform.developer.createProject(
        platform.appId,
        {
            clientReference: "runtime-test",
            displayName: "Runtime test",
            idempotencyKey: "runtime-test",
            locationHint: "apac",
        },
        signal,
    );
    const runtime = await platform.connectAgent(project.projectId);
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
