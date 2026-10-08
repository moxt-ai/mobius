import { InProcessAcpAgentDefinition } from "@moxt-ai/mobius/runtime";
import { createFakeHarness, fakeHarnessCapabilities } from "./fake-harness/index.ts";
import type { FakeAgentHarnessOptions } from "./fake-harness/model.ts";

/** Composes the production daemon's injected Agent type with a controlled ACP harness. */
export function createFakeDaemon(options: FakeAgentHarnessOptions) {
    const harness = createFakeHarness(options);
    return {
        agents: harness.agents.map(
            (agent) =>
                new InProcessAcpAgentDefinition(
                    agent.id,
                    agent.name,
                    process.execPath,
                    agent.createEndpoint,
                    {},
                    "controlled-harness",
                    undefined,
                    fakeHarnessCapabilities,
                ),
        ),
        catalog: harness.catalog,
        continueReply: harness.continueReply,
    };
}

export type { FakeAgentHarnessOptions, HarnessOutput, HarnessReplyPlan } from "./fake-harness/model.ts";
export { fakeHarnessCapabilities as fakeDaemonCapabilities };
