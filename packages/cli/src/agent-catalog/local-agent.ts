import { realpathSync, statSync } from "node:fs";

import { ExecutableIdentity } from "../process/executable.ts";

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
  readonly environment: Readonly<Record<string, string>>;
  readonly id: string;
  readonly label: string;
  readonly promptTimeoutMilliseconds: number;

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
    promptTimeoutMilliseconds = 30 * 60 * 1_000,
  ) {
    if (
      !Number.isSafeInteger(promptTimeoutMilliseconds) ||
      promptTimeoutMilliseconds < 1
    ) {
      throw new Error("The local Agent prompt deadline is invalid");
    }
    this.adapterIdentity = adapterIdentity;
    this.adapterPath = adapterIdentity.realPath;
    this.adapterVersion = adapterVersion;
    this.agentIdentity = agentIdentity;
    this.agentVersion = agentVersion;
    this.id = id;
    this.label = label;
    this.promptTimeoutMilliseconds = promptTimeoutMilliseconds;
    this.command = adapterIdentity.realPath;
    this.arguments = Object.freeze([...arguments_]);
    this.environment = Object.freeze({ ...environment });
  }
}

export class InstallableAgentDefinition {
  readonly id: string;
  readonly label: string;
  readonly requiresLocalApproval: boolean;

  constructor(id: string, label: string, requiresLocalApproval = true) {
    this.id = id;
    this.label = label;
    this.requiresLocalApproval = requiresLocalApproval;
  }
}

export class LocalAgentCatalogSnapshot {
  readonly agents: readonly LocalAgentDefinition[];
  readonly installableAgents: readonly InstallableAgentDefinition[];

  constructor(
    agents: readonly LocalAgentDefinition[],
    installableAgents: readonly InstallableAgentDefinition[],
  ) {
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

  constructor(
    agents: readonly LocalAgentDefinition[],
    installableAgents: readonly InstallableAgentDefinition[],
  ) {
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
