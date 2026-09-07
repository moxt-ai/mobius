import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentInstallationStage } from "@moxt-ai/mobius-protocol";

import { AvailableAgent } from "../agent-catalog/agent-discovery.ts";
import {
  BridgedAcpAgentDefinition,
  DirectAcpAgentDefinition,
  type LocalAgentSpecification,
} from "../agent-catalog/agent-specification.ts";
import { supportedLocalAgentSpecifications } from "../agent-catalog/agents/supported-agent-specifications.ts";
import { discoverLocalAgentInventory } from "../agent-catalog/discover-local-agents.ts";
import {
  resolveAdapterExecutable,
  resolveAgentExecutable,
} from "../agent-catalog/executable-discovery.ts";
import type { LocalAgentCatalog } from "../agent-catalog/local-agent.ts";
import { ProcessExecutionError } from "../process/executable.ts";
import type {
  InstallationAudit,
  InstallationExecutor,
} from "./agent-installation-manager.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";
import {
  type FixedAgentInstallRecipe,
  fixedAgentInstallRecipes,
} from "./fixed-agent-install-recipes.ts";
import {
  type AdapterInstallationPort,
  ManagedAdapterInstallError,
  ManagedAdapterInstaller,
} from "./managed-adapter-installer.ts";
import { InstallerDownloadError } from "./verified-download.ts";

export interface FixedInstallationExecutorOptions {
  readonly defaultWorkspace: string;
  readonly audit: InstallationAudit;
  readonly catalog: LocalAgentCatalog;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly publishCatalog: (signal: AbortSignal) => Promise<void>;
  readonly stateDirectory: string;
}

function findSpecification(
  specifications: readonly LocalAgentSpecification[],
  agentId: string,
): LocalAgentSpecification {
  for (const specification of specifications) {
    if (specification.id === agentId) {
      return specification;
    }
  }
  throw new InstallationManagerError(
    "unknown_agent",
    "The requested Agent is not supported",
  );
}

function findRecipe(
  recipes: readonly FixedAgentInstallRecipe[],
  agentId: string,
): FixedAgentInstallRecipe {
  for (const recipe of recipes) {
    if (recipe.id === agentId) {
      return recipe;
    }
  }
  throw new InstallationManagerError(
    "agent_not_installable",
    "The requested Agent does not have an approved installation recipe",
  );
}

function resolveDefaultWorkspace(path: string): string {
  try {
    const directory = realpathSync(resolve(path));
    if (!statSync(directory).isDirectory()) {
      throw new Error("Default workspace is not a directory");
    }
    return directory;
  } catch (error) {
    throw new InstallationManagerError(
      "unsafe_installation_root",
      "The default workspace is unavailable or unsafe",
      { cause: error },
    );
  }
}

function resolveUserInstallationDirectory(path: string): string {
  try {
    const directory = realpathSync(resolve(path));
    const metadata = statSync(directory);
    if (
      !metadata.isDirectory() ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new Error("Installation directory is not user-owned");
    }
    return directory;
  } catch (error) {
    throw new InstallationManagerError(
      "unsafe_installation_root",
      "The local Agent installation root is unavailable or unsafe",
      { cause: error },
    );
  }
}

function translateExecutionError(error: unknown): InstallationManagerError {
  if (error instanceof InstallationManagerError) {
    return error;
  }
  if (
    error instanceof ManagedAdapterInstallError ||
    error instanceof InstallerDownloadError ||
    error instanceof ProcessExecutionError
  ) {
    return new InstallationManagerError(error.code, error.message, {
      cause: error,
    });
  }
  return new InstallationManagerError(
    "installation_failed",
    "The fixed local Agent installation failed",
    { cause: error },
  );
}

function requiresAgentReplacement(code: string): boolean {
  return (
    code === "agent_not_found" ||
    code === "agent_probe_failed" ||
    code === "agent_probe_timeout"
  );
}

function requiresAdapterReplacement(code: string): boolean {
  return (
    code === "adapter_not_found" ||
    code === "adapter_probe_failed" ||
    code === "adapter_probe_timeout" ||
    code === "acp_incompatible"
  );
}

export class FixedInstallationExecutor implements InstallationExecutor {
  readonly #adapterInstaller: AdapterInstallationPort;
  readonly #defaultWorkspace: string;
  readonly #audit: InstallationAudit;
  readonly #catalog: LocalAgentCatalog;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #publishCatalog: (signal: AbortSignal) => Promise<void>;
  readonly #recipes: readonly FixedAgentInstallRecipe[];
  readonly #specifications: readonly LocalAgentSpecification[];
  readonly #stateDirectory: string;

  constructor(
    options: FixedInstallationExecutorOptions,
    specifications: readonly LocalAgentSpecification[] = supportedLocalAgentSpecifications(),
    recipes: readonly FixedAgentInstallRecipe[] = fixedAgentInstallRecipes(),
    adapterInstaller?: AdapterInstallationPort,
  ) {
    const defaultWorkspace = resolveDefaultWorkspace(options.defaultWorkspace);
    const stateDirectory = resolveUserInstallationDirectory(
      options.stateDirectory,
    );
    this.#defaultWorkspace = defaultWorkspace;
    this.#audit = options.audit;
    this.#catalog = options.catalog;
    this.#environment = Object.freeze({ ...options.environment });
    this.#publishCatalog = options.publishCatalog;
    this.#recipes = Object.freeze([...recipes]);
    this.#specifications = Object.freeze([...specifications]);
    this.#stateDirectory = stateDirectory;
    this.#adapterInstaller =
      adapterInstaller ??
      new ManagedAdapterInstaller({
        environment: this.#environment,
        stateDirectory,
      });
  }

  readonly execute = async (
    agentId: string,
    requestId: string,
    report: (stage: AgentInstallationStage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      const specification = findSpecification(this.#specifications, agentId);
      const recipe = findRecipe(this.#recipes, agentId);
      this.#audit.record(
        "agent_installation_recipe_resolved",
        requestId,
        agentId,
        {
          adapterVersion: specification.adapterVersion,
          releaseChannel: recipe.releaseChannel,
        },
      );
      const discoveryOptions = {
        defaultWorkspace: this.#defaultWorkspace,
        environment: this.#environment,
        signal,
      };
      let agent = await resolveAgentExecutable(specification, discoveryOptions);
      let installedAgent = false;
      if (agent === null) {
        agent = await recipe.install({
          audit: this.#audit,
          environment: this.#environment,
          report,
          requestId,
          signal,
          stateDirectory: this.#stateDirectory,
        });
        installedAgent = true;
      }
      let adapter =
        specification instanceof DirectAcpAgentDefinition
          ? agent
          : await resolveAdapterExecutable(specification, discoveryOptions);
      let installedAdapter = false;
      if (adapter === null) {
        if (!(specification instanceof BridgedAcpAgentDefinition)) {
          throw new InstallationManagerError(
            "agent_verification_failed",
            "The direct Agent executable is unavailable",
          );
        }
        await report("installing_adapter");
        adapter = await this.#adapterInstaller.install(specification, signal);
        installedAdapter = true;
        this.#audit.record("agent_adapter_verified", requestId, agentId, {
          version: specification.adapterVersion,
        });
      }

      while (true) {
        await report("checking_acp");
        const environment: NodeJS.ProcessEnv = { ...this.#environment };
        environment[specification.agentOverrideVariable] = agent.path;
        environment[specification.adapterOverrideVariable] = adapter.path;
        const inventory = await discoverLocalAgentInventory({
          defaultWorkspace: this.#defaultWorkspace,
          environment,
          signal,
          specifications: this.#specifications,
        });
        const verified = inventory.available.find(
          (candidate) => candidate.specification.id === agentId,
        );
        if (verified instanceof AvailableAgent) {
          this.#audit.record(
            "agent_installation_acp_verified",
            requestId,
            agentId,
            {
              adapterVersion: verified.agent.adapterVersion,
              agentVersion: verified.agent.agentVersion,
            },
          );

          const previous = this.#catalog.read();
          this.#catalog.transition(
            inventory.readyAgents(),
            inventory.installable,
          );
          try {
            await this.#publishCatalog(signal);
          } catch (error) {
            this.#catalog.transition(
              previous.agents,
              previous.installableAgents,
            );
            throw error;
          }
          return;
        }

        const unavailable = inventory.unavailable.find(
          (candidate) => candidate.specification.id === agentId,
        );
        if (unavailable === undefined) {
          throw new InstallationManagerError(
            "agent_verification_failed",
            "The complete Agent ACP path did not pass verification",
          );
        }
        if (
          !installedAdapter &&
          specification instanceof BridgedAcpAgentDefinition &&
          requiresAdapterReplacement(unavailable.code)
        ) {
          await report("installing_adapter");
          adapter = await this.#adapterInstaller.install(specification, signal);
          installedAdapter = true;
          this.#audit.record("agent_adapter_verified", requestId, agentId, {
            version: specification.adapterVersion,
          });
          continue;
        }
        if (
          !installedAgent &&
          (requiresAgentReplacement(unavailable.code) ||
            unavailable.code === "acp_incompatible")
        ) {
          agent = await recipe.install({
            audit: this.#audit,
            environment: this.#environment,
            report,
            requestId,
            signal,
            stateDirectory: this.#stateDirectory,
          });
          installedAgent = true;
          if (specification instanceof DirectAcpAgentDefinition) {
            adapter = agent;
          }
          continue;
        }
        throw new InstallationManagerError(
          unavailable.code,
          unavailable.message,
        );
      }
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      throw translateExecutionError(error);
    }
  };
}
