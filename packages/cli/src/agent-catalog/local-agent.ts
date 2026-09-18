import { realpathSync, statSync } from "node:fs";
import type { SessionCapabilities } from "@moxt-ai/mobius-protocol";

import { unsupportedSessionCapabilities } from "../acp/session-capabilities.ts";
import { ExecutableIdentity } from "../process/executable.ts";
import {
    AGENT_DEFAULT_PERMISSION_MODE,
    type AgentPermissionProfile,
    permissionProfileForAgent,
} from "./agent-permission-profile.ts";

function readTrustedIdentity(path: string): ExecutableIdentity {
    const resolvedPath = realpathSync(path);
    const metadata = statSync(resolvedPath);
    return new ExecutableIdentity(
        resolvedPath,
        resolvedPath,
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.ctimeMs,
    );
}

export class LocalAgentDefinition {
    readonly adapterIdentity: ExecutableIdentity;
    readonly adapterPath: string;
    readonly adapterVersion: string;
    readonly agentIdentity: ExecutableIdentity;
    readonly agentVersion: string;
    readonly arguments: readonly string[];
    readonly command: string;
    readonly capabilities: SessionCapabilities;
    readonly environment: Readonly<Record<string, string>>;
    readonly id: string;
    readonly label: string;
    readonly permissionProfile: AgentPermissionProfile;

    constructor(
        id: string,
        label: string,
        command: string,
        arguments_: readonly string[],
        environment: Readonly<Record<string, string>> = {},
        adapterVersion = "",
        agentVersion = "",
        adapterIdentity: ExecutableIdentity = readTrustedIdentity(command),
        agentIdentity: ExecutableIdentity = adapterIdentity,
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
        permissionProfile: AgentPermissionProfile = permissionProfileForAgent(id),
    ) {
        this.adapterIdentity = adapterIdentity;
        this.adapterPath = adapterIdentity.realPath;
        this.adapterVersion = adapterVersion;
        this.agentIdentity = agentIdentity;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.id = id;
        this.label = label;
        this.permissionProfile = permissionProfile;
        this.command = adapterIdentity.realPath;
        this.arguments = Object.freeze([...arguments_]);
        this.environment = permissionProfile.apply(environment, permissionProfile.currentMode(environment));
    }

    readonly withPermissionMode = (permissionMode: string): LocalAgentDefinition => {
        if (
            permissionMode === AGENT_DEFAULT_PERMISSION_MODE &&
            this.permissionProfile.currentMode(this.environment) === AGENT_DEFAULT_PERMISSION_MODE
        ) {
            return this;
        }
        return new LocalAgentDefinition(
            this.id,
            this.label,
            this.command,
            this.arguments,
            this.permissionProfile.apply(this.environment, permissionMode),
            this.adapterVersion,
            this.agentVersion,
            this.adapterIdentity,
            this.agentIdentity,
            this.capabilities,
            this.permissionProfile,
        );
    };
}

export abstract class InstallableAgentDefinition {
    readonly id: string;
    readonly label: string;
    abstract readonly status: string;

    protected constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }
}

export class MissingAgentDefinition extends InstallableAgentDefinition {
    readonly status = "agent_not_installed";

    constructor(id: string, label: string) {
        super(id, label);
    }
}

export class AgentIntegrationDefinition extends InstallableAgentDefinition {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly status = "integration_not_installed";

    constructor(id: string, label: string, agentPath: string, agentVersion: string) {
        super(id, label);
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
    }
}

export class LocalAgentCatalogSnapshot {
    readonly agents: readonly LocalAgentDefinition[];
    readonly installableAgents: readonly InstallableAgentDefinition[];

    constructor(agents: readonly LocalAgentDefinition[], installableAgents: readonly InstallableAgentDefinition[]) {
        this.agents = Object.freeze([...agents]);
        this.installableAgents = Object.freeze([...installableAgents]);
    }
}

export class LocalAgentCatalogError extends Error {
    readonly code = "agent_not_ready";

    constructor() {
        super("The requested local Agent is not ready");
        this.name = "LocalAgentCatalogError";
    }
}

export class LocalAgentCatalog {
    #snapshot: LocalAgentCatalogSnapshot;

    constructor(agents: readonly LocalAgentDefinition[], installableAgents: readonly InstallableAgentDefinition[]) {
        this.#snapshot = this.validate(agents, installableAgents);
    }

    readonly find = (agentId: string): LocalAgentDefinition => {
        for (const agent of this.#snapshot.agents) {
            if (agent.id === agentId) {
                return agent;
            }
        }
        throw new LocalAgentCatalogError();
    };

    readonly read = (): LocalAgentCatalogSnapshot => this.#snapshot;

    readonly transition = (
        agents: readonly LocalAgentDefinition[],
        installableAgents: readonly InstallableAgentDefinition[],
    ): LocalAgentCatalogSnapshot => {
        const next = this.validate(agents, installableAgents);
        this.#snapshot = next;
        return next;
    };

    private readonly validate = (
        agents: readonly LocalAgentDefinition[],
        installableAgents: readonly InstallableAgentDefinition[],
    ): LocalAgentCatalogSnapshot => {
        const identifiers = new Set<string>();
        for (const agent of agents) {
            if (identifiers.has(agent.id)) {
                throw new Error("The local Agent catalog contains duplicate entries");
            }
            identifiers.add(agent.id);
        }
        for (const agent of installableAgents) {
            if (identifiers.has(agent.id)) {
                throw new Error("A local Agent cannot be ready and installable");
            }
            identifiers.add(agent.id);
        }
        return new LocalAgentCatalogSnapshot(agents, installableAgents);
    };
}
