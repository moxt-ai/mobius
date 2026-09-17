import {
    AGENT_DEFAULT_EXECUTION_SETTING,
    AGENT_PERMISSION_MODE_CONFIG_ID,
    type SessionConfigOption,
    type SessionConfigValue,
} from "@moxt-ai/mobius-protocol";

export const AGENT_DEFAULT_PERMISSION_MODE = AGENT_DEFAULT_EXECUTION_SETTING;
const READ_ONLY_PERMISSION_MODE = "read-only";
const WORKSPACE_WRITE_PERMISSION_MODE = "workspace-write";
const DANGER_FULL_ACCESS_PERMISSION_MODE = "danger-full-access";
export const PERMISSION_MODE_CONFIG_ID = AGENT_PERMISSION_MODE_CONFIG_ID;

const PERMISSION_MODE_MARKER = "MOBIUS_AGENT_PERMISSION_MODE";

export class AgentPermissionConfigurationError extends Error {
    readonly code = "invalid_agent_permission_configuration";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "AgentPermissionConfigurationError";
    }
}

export abstract class AgentPermissionProfile {
    abstract readonly apply: (
        environment: Readonly<Record<string, string>>,
        permissionMode: string,
    ) => Readonly<Record<string, string>>;
    abstract readonly currentMode: (environment: Readonly<Record<string, string>>) => string;
    abstract readonly description: string;
    abstract readonly values: readonly SessionConfigValue[];

    readonly option = (environment: Readonly<Record<string, string>>): SessionConfigOption => ({
        booleanValue: false,
        category: "_mobius_permission",
        currentValue: this.currentMode(environment),
        description: this.description,
        id: PERMISSION_MODE_CONFIG_ID,
        name: "Permissions",
        type: "select",
        values: this.values,
    });
}

class AgentManagedPermissionProfile extends AgentPermissionProfile {
    readonly description = "This Agent manages its own local permissions.";
    readonly values = Object.freeze([
        {
            description: "Managed by the Agent",
            groupId: "",
            groupName: "",
            name: "Agent default",
            value: AGENT_DEFAULT_PERMISSION_MODE,
        },
    ]);

    readonly currentMode = (): string => AGENT_DEFAULT_PERMISSION_MODE;

    readonly apply = (environment: Readonly<Record<string, string>>, permissionMode: string) => {
        if (permissionMode !== AGENT_DEFAULT_PERMISSION_MODE) {
            throw new AgentPermissionConfigurationError("The selected Agent does not support this permission mode");
        }
        return Object.freeze({ ...environment });
    };
}

class PiPermissionProfile extends AgentPermissionProfile {
    readonly description = "Pi has no built-in sandbox and runs with the local Runtime user's authority.";
    readonly values = Object.freeze([
        {
            description: "Pi default; unrestricted local execution with the Runtime user's authority",
            groupId: "",
            groupName: "",
            name: "Full access (Pi default)",
            value: DANGER_FULL_ACCESS_PERMISSION_MODE,
        },
    ]);

    readonly currentMode = (): string => DANGER_FULL_ACCESS_PERMISSION_MODE;

    readonly apply = (environment: Readonly<Record<string, string>>, permissionMode: string) => {
        if (permissionMode !== DANGER_FULL_ACCESS_PERMISSION_MODE) {
            throw new AgentPermissionConfigurationError("Pi only supports its default full-access permission mode");
        }
        return Object.freeze({ ...environment });
    };
}

const adjustablePermissionValues: readonly SessionConfigValue[] = Object.freeze([
    {
        description: "Keep the Agent's existing permission policy",
        groupId: "",
        groupName: "",
        name: "Agent default",
        value: AGENT_DEFAULT_PERMISSION_MODE,
    },
    {
        description: "Allow inspection without local writes or commands that can change state",
        groupId: "",
        groupName: "",
        name: "Read only",
        value: READ_ONLY_PERMISSION_MODE,
    },
    {
        description: "Allow changes inside the selected workspace while protecting external paths",
        groupId: "",
        groupName: "",
        name: "Workspace write",
        value: WORKSPACE_WRITE_PERMISSION_MODE,
    },
    {
        description: "Allow unrestricted local execution with the Runtime user's authority",
        groupId: "",
        groupName: "",
        name: "Full access",
        value: DANGER_FULL_ACCESS_PERMISSION_MODE,
    },
]);

function validateAdjustableMode(permissionMode: string): string {
    if (!adjustablePermissionValues.some((value) => value.value === permissionMode)) {
        throw new AgentPermissionConfigurationError("The selected permission mode is unavailable");
    }
    return permissionMode;
}

class DeepSeekHarnessPermissionProfile extends AgentPermissionProfile {
    readonly description = "Controls the local side effects allowed for this Agent session.";
    readonly values = adjustablePermissionValues;

    readonly currentMode = (environment: Readonly<Record<string, string>>): string =>
        validateAdjustableMode(environment["DSH_PERMISSION_MODE"] ?? WORKSPACE_WRITE_PERMISSION_MODE);

    readonly apply = (environment: Readonly<Record<string, string>>, permissionMode: string) => {
        if (permissionMode === AGENT_DEFAULT_PERMISSION_MODE) {
            return Object.freeze({ ...environment });
        }
        return Object.freeze({
            ...environment,
            DSH_PERMISSION_MODE: validateAdjustableMode(permissionMode),
            [PERMISSION_MODE_MARKER]: permissionMode,
        });
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new AgentPermissionConfigurationError("The OpenCode inline configuration is invalid");
    }
    return Object.fromEntries(Object.entries(value));
}

function openCodeConfiguration(environment: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
    const encoded = environment["OPENCODE_CONFIG_CONTENT"];
    if (encoded === undefined || encoded.length === 0) {
        return {};
    }
    try {
        return record(JSON.parse(encoded));
    } catch (cause) {
        if (cause instanceof AgentPermissionConfigurationError) {
            throw cause;
        }
        throw new AgentPermissionConfigurationError("The OpenCode inline configuration is invalid", { cause });
    }
}

function openCodePermission(permissionMode: string): unknown {
    if (permissionMode === READ_ONLY_PERMISSION_MODE) {
        return {
            "*": "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: "allow",
        };
    }
    if (permissionMode === WORKSPACE_WRITE_PERMISSION_MODE) {
        return {
            "*": "allow",
            external_directory: "ask",
        };
    }
    return "allow";
}

class OpenCodePermissionProfile extends AgentPermissionProfile {
    readonly description = "Controls the local side effects allowed for this Agent session.";
    readonly values = adjustablePermissionValues;

    readonly currentMode = (environment: Readonly<Record<string, string>>): string =>
        validateAdjustableMode(environment[PERMISSION_MODE_MARKER] ?? AGENT_DEFAULT_PERMISSION_MODE);

    readonly apply = (environment: Readonly<Record<string, string>>, permissionMode: string) => {
        const validated = validateAdjustableMode(permissionMode);
        if (validated === AGENT_DEFAULT_PERMISSION_MODE) {
            return Object.freeze({ ...environment });
        }
        return Object.freeze({
            ...environment,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...openCodeConfiguration(environment),
                permission: openCodePermission(validated),
            }),
            [PERMISSION_MODE_MARKER]: validated,
        });
    };
}

const agentManagedPermissionProfile = new AgentManagedPermissionProfile();
const deepSeekHarnessPermissionProfile = new DeepSeekHarnessPermissionProfile();
const openCodePermissionProfile = new OpenCodePermissionProfile();
const piPermissionProfile = new PiPermissionProfile();

export function permissionProfileForAgent(agentId: string): AgentPermissionProfile {
    if (agentId === "deepseek-harness") {
        return deepSeekHarnessPermissionProfile;
    }
    if (agentId === "opencode") {
        return openCodePermissionProfile;
    }
    if (agentId === "pi") {
        return piPermissionProfile;
    }
    return agentManagedPermissionProfile;
}
