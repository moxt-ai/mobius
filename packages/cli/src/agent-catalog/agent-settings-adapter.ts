import type { SessionConfigurationSelection } from "@moxt-ai/mobius-protocol";
import { AgentSettingsAdapter, AppliedAgentLaunchSettings } from "./agent-settings-base.ts";
import { CodexSettingsAdapter } from "./agents/codex-settings-adapter.ts";
import type { AcpAgentDefinition } from "./local-agent.ts";

export {
    AgentSettingsAdapter,
    AgentSettingsLaunchSelectionResult,
    AppliedAgentLaunchSettings,
} from "./agent-settings-base.ts";

const genericAdapter = new AgentSettingsAdapter();
const codexAdapter = new CodexSettingsAdapter();

export function agentSettingsAdapterForAgent(agentId: string): AgentSettingsAdapter {
    if (agentId === "codex") {
        return codexAdapter;
    }
    return genericAdapter;
}

export function applyAgentLaunchSettings(
    agent: AcpAgentDefinition,
    selections: readonly SessionConfigurationSelection[],
): AppliedAgentLaunchSettings {
    const adapter = agentSettingsAdapterForAgent(agent.id);
    let selectedAgent = agent;
    const sessionConfigurations: SessionConfigurationSelection[] = [];
    for (const selection of selections) {
        const applied = adapter.applyLaunchSelection(selectedAgent, selection);
        selectedAgent = applied.agent;
        if (!applied.handled) {
            sessionConfigurations.push(selection);
        }
    }
    return new AppliedAgentLaunchSettings(selectedAgent, sessionConfigurations);
}
