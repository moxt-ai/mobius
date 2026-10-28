import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgentDefinition } from "../../../cli/src/engine/acp/agent/agent-definition.ts";
import type { AgentConnectionOptions } from "../../../cli/src/engine/acp/connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../../cli/src/engine/acp/connection/endpoint-agent-connection.ts";
import { createFakeHarness, fakeHarnessCapabilities } from "./fake-harness/index.ts";
import type { FakeAgentHarnessOptions } from "./fake-harness/model.ts";

export type ControlledSessionUpdate = (notification: SessionNotification) => Promise<void>;

/** Adapts the controlled ACP peer to the same awaited update port used by native Agents. */
export const controlledSessionUpdates =
    (client: AgentConnectionOptions["client"]): ControlledSessionUpdate =>
    async (notification) => {
        const update = notification.update;
        switch (update.sessionUpdate) {
            case "user_message_chunk":
            case "agent_message_chunk":
            case "agent_thought_chunk":
                if (typeof update.messageId !== "string" || update.messageId.length === 0) {
                    throw new Error("The controlled ACP peer must identify message chunks");
                }
                await client.onUpdate({ ...notification, update: { ...update, messageId: update.messageId } });
                break;
            default:
                await client.onUpdate({ ...notification, update });
        }
    };

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
                    (options) =>
                        new ControlledEndpointConnection(
                            agent.createEndpoint(controlledSessionUpdates(options.client)),
                            options.client,
                        ),
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
