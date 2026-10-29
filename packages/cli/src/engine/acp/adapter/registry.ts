import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { Adapter, AdapterDependencies, AdapterResolver } from "../native-history/preview-contract.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { PiAdapter } from "./pi/adapter.ts";

/** Each supported harness owns its adapter; unregistered harnesses are rejected. */
export const harnessAdapters: AdapterResolver = (
    agent: AcpAgentDefinition,
    dependencies: AdapterDependencies,
): Adapter => {
    switch (agent.id) {
        case "codex":
            return new CodexAdapter(agent, dependencies);
        case "claude":
            return new ClaudeAdapter(agent, dependencies);
        case "pi":
            return new PiAdapter(agent, dependencies);
        default:
            throw new AcpExecutionError(
                `Agent "${agent.id}" has no registered harness adapter.`,
                {},
                "agent_adapter_not_found",
            );
    }
};
