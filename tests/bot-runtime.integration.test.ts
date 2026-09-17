import { DEFAULT_AGENT_EXECUTION_CONFIGURATION, MobiusNoBotCompletionPolicy } from "@moxt-ai/mobius-sdk/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StandaloneProjectStorageDirectory } from "../packages/relay-cloudflare-standalone/src/project-storage-directory.ts";
import { D1DatabaseAdapter } from "../packages/relay-core/src/infra/d1-database.ts";
import { createTestAgent } from "./infra/agent.ts";
import { createTestMobiusApp } from "./infra/app.ts";
import { createTestMobiusBindings } from "./infra/cloudflare.ts";
import { createTestGateways } from "./infra/gateways.ts";
import { createTestRuntime } from "./infra/runtime.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

it("Given a Bot needing setup, When its owner selects a local Runtime target, Then the Bot is ready immediately", async () => {
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
    const owner = runtime.owner;

    const bot = await owner.createBot({ displayName: "Assistant", avatarRef: "", description: "" }, signal);
    expect(bot.state.kind).toBe("draft");
    const behavior = await owner.createBehavior(
        bot.botId,
        {
            expectedRevision: 0,
            instructions: "Help the owner",
            requiredCapabilities: [],
            agentConfiguration: {},
        },
        signal,
    );
    const binding = await owner.createBinding(
        bot.botId,
        {
            agentConfigRevision: 1,
            agentRef: agent.definition.id,
            allowedDeliveryTargetIds: [],
            behaviorRevisionId: behavior.behaviorRevisionId,
            completionPolicy: new MobiusNoBotCompletionPolicy(),
            executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
            expectedRevision: bot.lifecycleRevision,
            runtimeId: runtime.runtimeId,
            workspaceRef: "default",
        },
        signal,
    );
    expect(await owner.listBindings(bot.botId, signal)).toMatchObject({
        executionBindings: [
            expect.objectContaining({
                bindingId: binding.bindingId,
                executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
            }),
        ],
    });
    expect(await owner.readBot(bot.botId, signal)).toMatchObject({
        state: {
            kind: "active",
            activeBindingId: binding.bindingId,
            activeBehaviorRevisionId: behavior.behaviorRevisionId,
        },
    });
});
