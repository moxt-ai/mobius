import {
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    type SessionConfigValue,
} from "@moxt-ai/mobius-protocol";

import type { AcpAgentDefinition } from "./local-agent.ts";

const AGENT_DEFAULT_VALUE = "agent_default";
const READ_ONLY_VALUE = "read-only";
const WORKSPACE_WRITE_VALUE = "workspace-write";
const DANGER_FULL_ACCESS_VALUE = "danger-full-access";

export const DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID = "dsh_access_mode";
export const OPENCODE_PERMISSION_SETTING_ID = "opencode_permission";

class AgentSettingsConfigurationError extends Error {
    readonly code = "invalid_session_configuration";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "AgentSettingsConfigurationError";
    }
}

export class AgentSettingsLaunchSelectionResult {
    readonly agent: AcpAgentDefinition;
    readonly handled: boolean;

    constructor(agent: AcpAgentDefinition, handled: boolean) {
        this.agent = agent;
        this.handled = handled;
    }
}

export class AppliedAgentLaunchSettings {
    readonly agent: AcpAgentDefinition;
    readonly sessionConfigurations: readonly SessionConfigurationSelection[];

    constructor(agent: AcpAgentDefinition, sessionConfigurations: readonly SessionConfigurationSelection[]) {
        this.agent = agent;
        this.sessionConfigurations = Object.freeze([...sessionConfigurations]);
    }
}

export class AgentSettingsAdapter {
    readonly modelEffortResolution: string = AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION;

    readonly applyLaunchSelection = (
        agent: AcpAgentDefinition,
        _selection: SessionConfigurationSelection,
    ): AgentSettingsLaunchSelectionResult => new AgentSettingsLaunchSelectionResult(agent, false);

    readonly settings = (_agent: AcpAgentDefinition): readonly SessionConfigOption[] => [];
}

function selectValue(name: string, value: string, description: string): SessionConfigValue {
    return {
        description,
        groupId: "",
        groupName: "",
        name,
        value,
    };
}

function selectSetting(
    id: string,
    name: string,
    description: string,
    currentValue: string,
    values: readonly SessionConfigValue[],
): SessionConfigOption {
    return {
        booleanValue: false,
        category: "execution",
        currentValue,
        description,
        id,
        name,
        type: "select",
        values,
    };
}

function selectedValue(selection: SessionConfigurationSelection, configId: string): string {
    if (
        selection.configId !== configId ||
        selection.valueType !== "select" ||
        selection.booleanValue ||
        selection.value.length === 0
    ) {
        throw new AgentSettingsConfigurationError("The requested Agent setting is invalid");
    }
    return selection.value;
}

function validValue(values: readonly SessionConfigValue[], value: string): string {
    if (!values.some((candidate) => candidate.value === value)) {
        throw new AgentSettingsConfigurationError("The requested Agent setting is unavailable");
    }
    return value;
}

const dshAccessModes: readonly SessionConfigValue[] = Object.freeze([
    selectValue("Read only", READ_ONLY_VALUE, "Allow inspection without local writes."),
    selectValue("Workspace write", WORKSPACE_WRITE_VALUE, "Allow changes in the selected workspace."),
    selectValue("Full access", DANGER_FULL_ACCESS_VALUE, "Allow unrestricted local execution."),
]);

class DeepSeekHarnessSettingsAdapter extends AgentSettingsAdapter {
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

class OpenCodeSettingsAdapter extends AgentSettingsAdapter {
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

class CodexSettingsAdapter extends AgentSettingsAdapter {
    override readonly modelEffortResolution = AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE;
}

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
