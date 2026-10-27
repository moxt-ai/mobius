import { AcpAgentDefinition, EndpointAgentConnection } from "@moxt-ai/mobius/runtime";
import { createFakeHarness, fakeHarnessCapabilities } from "./fake-harness/index.ts";
import type { FakeAgentHarnessOptions } from "./fake-harness/model.ts";

/** Connects controlled ACP endpoints through the shared vendor transport mechanics. */
export class ControlledEndpointConnection extends EndpointAgentConnection {}

/** Composes the production daemon's injected Agent type with a controlled ACP harness. */
export function createFakeDaemon(options: FakeAgentHarnessOptions) {
    const harness = createFakeHarness(options);
    return {
        agents: harness.agents.map(
            (agent) =>
                new AcpAgentDefinition(
                    agent.id,
                    agent.name,
                    process.execPath,
                    (options) => new ControlledEndpointConnection(agent.createEndpoint(), options.client),
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
