import type { SessionConfigurationSelection } from "@moxt-ai/mobius-protocol";
import { AgentSettingsAdapter, AppliedAgentLaunchSettings } from "./agent-settings-base.ts";
import { CodexSettingsAdapter } from "./agents/codex-settings-adapter.ts";
import { DeepSeekHarnessSettingsAdapter } from "./agents/deepseek-settings-adapter.ts";
import { OpenCodeSettingsAdapter } from "./agents/opencode-settings-adapter.ts";
import type { AcpAgentDefinition } from "./local-agent.ts";

export {
    AgentSettingsAdapter,
    AgentSettingsLaunchSelectionResult,
    AppliedAgentLaunchSettings,
} from "./agent-settings-base.ts";
export { DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID } from "./agents/deepseek-settings-adapter.ts";
export { OPENCODE_PERMISSION_SETTING_ID } from "./agents/opencode-settings-adapter.ts";

const genericAdapter = new AgentSettingsAdapter();
const codexAdapter = new CodexSettingsAdapter();
const deepSeekHarnessAdapter = new DeepSeekHarnessSettingsAdapter();
const openCodeAdapter = new OpenCodeSettingsAdapter();

export function agentSettingsAdapterForAgent(agentId: string): AgentSettingsAdapter {
    if (agentId === "codex") {
        return codexAdapter;
    }
    if (agentId === "deepseek-harness") {
        return deepSeekHarnessAdapter;
    }
    if (agentId === "opencode") {
        return openCodeAdapter;
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
