import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import type { Adapter, AdapterResolver } from "./context.ts";
import { PiAdapter } from "./pi/adapter.ts";

/** Daemon wiring: each known harness gets its own adapter; an unknown agent is an error. */
export const harnessAdapters: AdapterResolver = (agent: AcpAgentDefinition): Adapter => {
    switch (agent.id) {
        case "codex":
            return new CodexAdapter();
        case "claude":
            return new ClaudeAdapter();
        case "pi":
            return new PiAdapter();
        default:
            throw new AcpExecutionError(
                `Agent "${agent.id}" has no adapter for previewing saved sessions.`,
                {},
                "agent_adapter_not_found",
            );
    }
};
