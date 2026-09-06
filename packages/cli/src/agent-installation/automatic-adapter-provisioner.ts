import { randomUUID } from "node:crypto";

import {
  AvailableAgent,
  discoverLocalAgentInventory,
  findVerifiedAgentExecutable,
  type LocalAgentInventory,
  type LocalAgentSpecification,
  supportedLocalAgentSpecifications,
  type UnavailableAgent,
} from "../agent-catalog/discover-local-agents.ts";
import type { LocalAgentCatalog } from "../agent-catalog/local-agent.ts";
import type { ResolvedExecutable } from "../process/executable.ts";
import type { InstallationAudit } from "./agent-installation-manager.ts";
import {
  type AdapterInstallationPort,
  ManagedAdapterInstallError,
} from "./managed-adapter-installer.ts";

const AUTOMATIC_ADAPTER_FAILURE_CODES = new Set([
  "adapter_not_found",
  "adapter_probe_failed",
  "adapter_probe_timeout",
  "acp_incompatible",
]);

export interface AutomaticAdapterProvisionerOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly defaultWorkspace: string;
  readonly audit: InstallationAudit;
  readonly catalog: LocalAgentCatalog;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
}

class InstalledAutomaticAdapter {
  readonly executable: ResolvedExecutable;
  readonly requestId: string;
  readonly specification: LocalAgentSpecification;

  constructor(
    specification: LocalAgentSpecification,
    requestId: string,
    executable: ResolvedExecutable,
  ) {
    this.executable = executable;
    this.requestId = requestId;
    this.specification = specification;
  }
}

function shouldProvisionAdapter(
  unavailable: UnavailableAgent,
  options: AutomaticAdapterProvisionerOptions,
): boolean {
  return (
    AUTOMATIC_ADAPTER_FAILURE_CODES.has(unavailable.code) &&
    options.environment[unavailable.specification.adapterOverrideVariable] ===
      undefined &&
    unavailable.specification.supportsInstallation(
      options.platform ?? process.platform,
      options.architecture ?? process.arch,
    )
  );
}

function stableFailureCode(error: unknown): string {
  return error instanceof ManagedAdapterInstallError
    ? error.code
    : "adapter_install_failed";
}

function discoveryOptions(
  options: AutomaticAdapterProvisionerOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
  specifications: readonly LocalAgentSpecification[],
): Parameters<typeof discoverLocalAgentInventory>[0] {
  return {
    ...(options.architecture === undefined
      ? {}
      : { architecture: options.architecture }),
    defaultWorkspace: options.defaultWorkspace,
    environment,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    signal,
    specifications,
  };
}

export class AutomaticAdapterProvisioner {
  readonly #adapterInstaller: AdapterInstallationPort;
  readonly #options: AutomaticAdapterProvisionerOptions;
  readonly #specifications: readonly LocalAgentSpecification[];

  constructor(
    options: AutomaticAdapterProvisionerOptions,
    adapterInstaller: AdapterInstallationPort,
    specifications: readonly LocalAgentSpecification[] = supportedLocalAgentSpecifications(),
  ) {
    this.#adapterInstaller = adapterInstaller;
    this.#options = options;
    this.#specifications = Object.freeze([...specifications]);
  }

  readonly prepare = async (
    signal: AbortSignal,
  ): Promise<LocalAgentInventory> => {
    signal.throwIfAborted();
    let inventory = await discoverLocalAgentInventory(
      discoveryOptions(
        this.#options,
        this.#options.environment,
        signal,
        this.#specifications,
      ),
    );
    const candidates = inventory.unavailable.filter((unavailable) =>
      shouldProvisionAdapter(unavailable, this.#options),
    );
    const attempts: (InstalledAutomaticAdapter | null)[] = [];
    for (const unavailable of candidates) {
      signal.throwIfAborted();
      const specification = unavailable.specification;
      const verifiedAgent = await findVerifiedAgentExecutable(
        specification,
        discoveryOptions(
          this.#options,
          this.#options.environment,
          signal,
          this.#specifications,
        ),
      );
      if (verifiedAgent === null) {
        attempts.push(null);
        continue;
      }

      const requestId = `automatic-adapter-${randomUUID()}`;
      this.#options.audit.record(
        "agent_adapter_auto_install_started",
        requestId,
        specification.id,
        {
          agentVersion: verifiedAgent.version,
          adapterVersion: specification.adapterVersion,
        },
      );
      process.stdout.write(
        `Installing the pinned ACP adapter for ${specification.label}.\n`,
      );
      try {
        const executable = await this.#adapterInstaller.install(
          specification,
          signal,
        );
        this.#options.audit.record(
          "agent_adapter_auto_install_completed",
          requestId,
          specification.id,
          { adapterVersion: specification.adapterVersion },
        );
        attempts.push(
          new InstalledAutomaticAdapter(specification, requestId, executable),
        );
      } catch (error) {
        if (signal.aborted) {
          this.#options.audit.record(
            "agent_adapter_auto_install_cancelled",
            requestId,
            specification.id,
          );
          signal.throwIfAborted();
        }
        this.#options.audit.record(
          "agent_adapter_auto_install_failed",
          requestId,
          specification.id,
          { code: stableFailureCode(error) },
        );
        process.stderr.write(
          `The pinned ACP adapter for ${specification.label} could not be installed automatically; the daemon will continue.\n`,
        );
        attempts.push(null);
      }
    }
    signal.throwIfAborted();

    const installed = attempts.filter(
      (attempt): attempt is InstalledAutomaticAdapter => attempt !== null,
    );
    if (installed.length > 0) {
      const verificationEnvironment: NodeJS.ProcessEnv = {
        ...this.#options.environment,
      };
      for (const attempt of installed) {
        verificationEnvironment[attempt.specification.adapterOverrideVariable] =
          attempt.executable.path;
      }
      inventory = await discoverLocalAgentInventory(
        discoveryOptions(
          this.#options,
          verificationEnvironment,
          signal,
          this.#specifications,
        ),
      );
    }

    this.#options.catalog.transition(
      inventory.readyAgents(),
      inventory.installable,
    );
    for (const attempt of installed) {
      const available = inventory.available.find(
        (candidate) =>
          candidate instanceof AvailableAgent &&
          candidate.specification.id === attempt.specification.id,
      );
      if (available === undefined) {
        const unavailable = inventory.unavailable.find(
          (candidate) =>
            candidate.specification.id === attempt.specification.id,
        );
        this.#options.audit.record(
          "agent_adapter_auto_install_verification_failed",
          attempt.requestId,
          attempt.specification.id,
          { code: unavailable?.code ?? "agent_verification_failed" },
        );
        continue;
      }
      this.#options.audit.record(
        "agent_adapter_auto_install_verified",
        attempt.requestId,
        attempt.specification.id,
        {
          adapterVersion: available.agent.adapterVersion,
          agentVersion: available.agent.agentVersion,
        },
      );
      process.stdout.write(
        `${attempt.specification.label} ACP integration is ready.\n`,
      );
    }
    return inventory;
  };
}
