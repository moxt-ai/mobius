import type { LocalAgentSpecification } from "./agent-specification.ts";
import {
  InstallableAgentDefinition,
  type LocalAgentDefinition,
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

  constructor(
    specification: LocalAgentSpecification,
    agent: LocalAgentDefinition,
  ) {
    super(specification);
    this.agent = agent;
  }
}

export abstract class UnavailableAgent extends AgentDiscovery {
  abstract readonly code: string;
  abstract readonly message: string;
}

export class MissingAdapter extends UnavailableAgent {
  readonly code = "adapter_not_found";
  readonly message = "ACP adapter not found";
  readonly status = "missing_adapter";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
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

export class ProbeFailed extends UnavailableAgent {
  readonly code: string;
  readonly message: string;
  readonly status = "probe_failed";

  constructor(
    specification: LocalAgentSpecification,
    code: string,
    message: string,
  ) {
    super(specification);
    this.code = code;
    this.message = message;
  }
}

export class IncompatibleAdapter extends UnavailableAgent {
  readonly code = "acp_incompatible";
  readonly message = "ACP adapter is incompatible";
  readonly status = "incompatible_adapter";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

export class AuthenticationRequiredAgent extends UnavailableAgent {
  readonly code = "authentication_required";
  readonly message = "Agent authentication is required";
  readonly status = "authentication_required";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

export class LocalAgentInventory {
  readonly available: readonly AvailableAgent[];
  readonly discoveries: readonly AgentDiscovery[];
  readonly installable: readonly InstallableAgentDefinition[];
  readonly unavailable: readonly UnavailableAgent[];

  constructor(
    discoveries: readonly AgentDiscovery[],
    platform: NodeJS.Platform = process.platform,
    architecture: NodeJS.Architecture = process.arch,
  ) {
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
      unavailable
        .filter(
          (discovery) =>
            !(discovery instanceof AuthenticationRequiredAgent) &&
            discovery.specification.supportsInstallation(
              platform,
              architecture,
            ),
        )
        .map(
          (discovery) =>
            new InstallableAgentDefinition(
              discovery.specification.id,
              discovery.specification.label,
            ),
        ),
    );
    this.unavailable = Object.freeze(unavailable);
  }

  readonly readyAgents = (): readonly LocalAgentDefinition[] =>
    this.available.map((discovery) => discovery.agent);
}
