import type { LocalAgentSpecification } from "./agent-specification.ts";
import {
    type AgentIntegrationDefinition,
    type InstallableAgentDefinition,
    type LocalAgentDefinition,
    MissingAgentDefinition,
} from "./local-agent.ts";

export abstract class AgentDiscovery {
    readonly specification: LocalAgentSpecification;
    abstract readonly status: string;

    protected constructor(specification: LocalAgentSpecification) {
        this.specification = specification;
    }
}

export class AvailableAgent extends AgentDiscovery {
    readonly agent: LocalAgentDefinition;
    readonly status = "ready";

    constructor(specification: LocalAgentSpecification, agent: LocalAgentDefinition) {
        super(specification);
        this.agent = agent;
    }
}

export abstract class UnavailableAgent extends AgentDiscovery {
    abstract readonly code: string;
    abstract readonly message: string;
}

export abstract class UnavailableInstalledAgent extends UnavailableAgent {
    readonly agent: AgentIntegrationDefinition;

    protected constructor(specification: LocalAgentSpecification, agent: AgentIntegrationDefinition) {
        super(specification);
        this.agent = agent;
    }
}

export class MissingAdapter extends UnavailableInstalledAgent {
    readonly code = "adapter_not_found";
    readonly message = "ACP adapter not found";
    readonly status = "missing_adapter";

    constructor(specification: LocalAgentSpecification, agent: AgentIntegrationDefinition) {
        super(specification, agent);
    }
}

export class MissingAgent extends UnavailableAgent {
    readonly code = "agent_not_found";
    readonly message = "Agent executable not found";
    readonly status = "missing_agent";

    constructor(specification: LocalAgentSpecification) {
        super(specification);
    }
}

export class AgentProbeFailed extends UnavailableAgent {
    readonly code: string;
    readonly message: string;
    readonly status = "probe_failed";

    constructor(specification: LocalAgentSpecification, code: string, message: string) {
        super(specification);
        this.code = code;
        this.message = message;
    }
}

export class IntegrationProbeFailed extends UnavailableInstalledAgent {
    readonly code: string;
    readonly message: string;
    readonly status = "probe_failed";

    constructor(
        specification: LocalAgentSpecification,
        agent: AgentIntegrationDefinition,
        code: string,
        message: string,
    ) {
        super(specification, agent);
        this.code = code;
        this.message = message;
    }
}

export class IncompatibleAdapter extends UnavailableInstalledAgent {
    readonly code = "acp_incompatible";
    readonly message: string;
    readonly status = "incompatible_adapter";

    constructor(specification: LocalAgentSpecification, agent: AgentIntegrationDefinition, message: string) {
        super(specification, agent);
        this.message = message;
    }
}

export class AuthenticationRequiredAgent extends UnavailableInstalledAgent {
    readonly code = "authentication_required";
    readonly message = "Agent authentication is required";
    readonly status = "authentication_required";

    constructor(specification: LocalAgentSpecification, agent: AgentIntegrationDefinition) {
        super(specification, agent);
    }
}

export class LocalAgentInventory {
    readonly available: readonly AvailableAgent[];
    readonly discoveries: readonly AgentDiscovery[];
    readonly installable: readonly InstallableAgentDefinition[];
    readonly unavailable: readonly UnavailableAgent[];

    constructor(discoveries: readonly AgentDiscovery[]) {
        const available: AvailableAgent[] = [];
        const unavailable: UnavailableAgent[] = [];
        for (const discovery of discoveries) {
            if (discovery instanceof AvailableAgent) {
                available.push(discovery);
            } else if (discovery instanceof UnavailableAgent) {
                unavailable.push(discovery);
            } else {
                throw new Error("Unsupported Agent discovery outcome");
            }
        }
        this.available = Object.freeze(available);
        this.discoveries = Object.freeze([...discoveries]);
        this.installable = Object.freeze(
            unavailable.map((discovery) =>
                discovery instanceof UnavailableInstalledAgent
                    ? discovery.agent
                    : new MissingAgentDefinition(discovery.specification.id, discovery.specification.label),
            ),
        );
        this.unavailable = Object.freeze(unavailable);
    }

    readonly readyAgents = (): readonly LocalAgentDefinition[] => this.available.map((discovery) => discovery.agent);
}
