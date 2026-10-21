import {
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    type SessionConfigValue,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AcpAgentDefinition } from "./local-agent.ts";

export class AgentSettingsConfigurationError extends Error {
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

export function selectValue(name: string, value: string, description: string): SessionConfigValue {
    return {
        description,
        groupId: "",
        groupName: "",
        name,
        value,
    };
}

export function selectSetting(
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

export function selectedValue(selection: SessionConfigurationSelection, configId: string): string {
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

export function validValue(values: readonly SessionConfigValue[], value: string): string {
    if (!values.some((candidate) => candidate.value === value)) {
        throw new AgentSettingsConfigurationError("The requested Agent setting is unavailable");
    }
    return value;
}
