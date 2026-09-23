import type { SessionConfigOption, SessionConfigurationSelection, SessionConfigValue } from "@moxt-ai/mobius-protocol";
import {
    AgentSettingsAdapter,
    AgentSettingsConfigurationError,
    AgentSettingsLaunchSelectionResult,
    selectedValue,
    selectSetting,
    selectValue,
    validValue,
} from "../agent-settings-base.ts";
import type { AcpAgentDefinition } from "../local-agent.ts";

const AGENT_DEFAULT_VALUE = "agent_default";
const READ_ONLY_VALUE = "read-only";
const WORKSPACE_WRITE_VALUE = "workspace-write";
const DANGER_FULL_ACCESS_VALUE = "danger-full-access";
export const OPENCODE_PERMISSION_SETTING_ID = "opencode_permission";

const openCodePermissionModes: readonly SessionConfigValue[] = Object.freeze([
    selectValue("Agent default", AGENT_DEFAULT_VALUE, "Keep OpenCode's existing permission policy."),
    selectValue("Read only", READ_ONLY_VALUE, "Allow inspection without local writes."),
    selectValue("Workspace write", WORKSPACE_WRITE_VALUE, "Allow changes in the selected workspace."),
    selectValue("Full access", DANGER_FULL_ACCESS_VALUE, "Allow unrestricted local execution."),
]);

function openCodeConfiguration(environment: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
    const encoded = environment["OPENCODE_CONFIG_CONTENT"];
    if (encoded === undefined || encoded.length === 0) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(encoded);
    } catch (cause) {
        throw new AgentSettingsConfigurationError("The OpenCode configuration is invalid", { cause });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new AgentSettingsConfigurationError("The OpenCode configuration is invalid");
    }
    return Object.freeze({ ...parsed });
}

function openCodePermission(value: string): unknown {
    if (value === READ_ONLY_VALUE) {
        return {
            "*": "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: "allow",
        };
    }
    if (value === WORKSPACE_WRITE_VALUE) {
        return {
            "*": "allow",
            external_directory: "ask",
        };
    }
    return "allow";
}

export class OpenCodeSettingsAdapter extends AgentSettingsAdapter {
    override readonly settings = (agent: AcpAgentDefinition): readonly SessionConfigOption[] => {
        const currentValue = agent.environment["MOBIUS_OPENCODE_PERMISSION"] ?? AGENT_DEFAULT_VALUE;
        return [
            selectSetting(
                OPENCODE_PERMISSION_SETTING_ID,
                "Permissions",
                "Controls OpenCode's local permission policy.",
                validValue(openCodePermissionModes, currentValue),
                openCodePermissionModes,
            ),
        ];
    };

    override readonly applyLaunchSelection = (
        agent: AcpAgentDefinition,
        selection: SessionConfigurationSelection,
    ): AgentSettingsLaunchSelectionResult => {
        if (selection.configId !== OPENCODE_PERMISSION_SETTING_ID) {
            return new AgentSettingsLaunchSelectionResult(agent, false);
        }
        const value = validValue(openCodePermissionModes, selectedValue(selection, OPENCODE_PERMISSION_SETTING_ID));
        if (value === AGENT_DEFAULT_VALUE) {
            return new AgentSettingsLaunchSelectionResult(agent, true);
        }
        return new AgentSettingsLaunchSelectionResult(
            agent.withEnvironment({
                ...agent.environment,
                MOBIUS_OPENCODE_PERMISSION: value,
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    ...openCodeConfiguration(agent.environment),
                    permission: openCodePermission(value),
                }),
            }),
            true,
        );
    };
}
