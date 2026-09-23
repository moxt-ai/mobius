import type { SessionConfigOption, SessionConfigurationSelection, SessionConfigValue } from "@moxt-ai/mobius-protocol";
import {
    AgentSettingsAdapter,
    AgentSettingsLaunchSelectionResult,
    selectedValue,
    selectSetting,
    selectValue,
    validValue,
} from "../agent-settings-base.ts";
import type { AcpAgentDefinition } from "../local-agent.ts";

const READ_ONLY_VALUE = "read-only";
const WORKSPACE_WRITE_VALUE = "workspace-write";
const DANGER_FULL_ACCESS_VALUE = "danger-full-access";
export const DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID = "dsh_access_mode";

const dshAccessModes: readonly SessionConfigValue[] = Object.freeze([
    selectValue("Read only", READ_ONLY_VALUE, "Allow inspection without local writes."),
    selectValue("Workspace write", WORKSPACE_WRITE_VALUE, "Allow changes in the selected workspace."),
    selectValue("Full access", DANGER_FULL_ACCESS_VALUE, "Allow unrestricted local execution."),
]);

export class DeepSeekHarnessSettingsAdapter extends AgentSettingsAdapter {
    override readonly settings = (agent: AcpAgentDefinition): readonly SessionConfigOption[] => {
        const configured = agent.environment["DSH_PERMISSION_MODE"] ?? WORKSPACE_WRITE_VALUE;
        return [
            selectSetting(
                DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID,
                "Access mode",
                "Controls the local side effects allowed for this DeepSeek Harness session.",
                validValue(dshAccessModes, configured),
                dshAccessModes,
            ),
        ];
    };

    override readonly applyLaunchSelection = (
        agent: AcpAgentDefinition,
        selection: SessionConfigurationSelection,
    ): AgentSettingsLaunchSelectionResult => {
        if (selection.configId !== DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID) {
            return new AgentSettingsLaunchSelectionResult(agent, false);
        }
        const value = validValue(dshAccessModes, selectedValue(selection, DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID));
        return new AgentSettingsLaunchSelectionResult(
            agent.withEnvironment({ ...agent.environment, DSH_PERMISSION_MODE: value }),
            true,
        );
    };
}
