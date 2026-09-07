import { join } from "node:path";

import type { LocalAgentSpecification } from "../agent-catalog/discover-local-agents.ts";
import type { ResolvedExecutable } from "../process/executable.ts";
import {
  ManagedNpmPackageError,
  type ManagedNpmPackageInstallationPort,
  ManagedNpmPackageInstaller,
  validateManagedNpmPackage,
} from "./managed-npm-package.ts";

export class ManagedAdapterInstallError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "ManagedAdapterInstallError";
  }
}

function translateError(error: unknown): ManagedAdapterInstallError {
  if (error instanceof ManagedAdapterInstallError) {
    return error;
  }
  if (error instanceof ManagedNpmPackageError) {
    if (error.code === "package_manager_not_found") {
      return new ManagedAdapterInstallError(
        error.code,
        "A supported npm executable is required to install the ACP adapter",
        { cause: error },
      );
    }
    if (error.code === "managed_package_verification_failed") {
      return new ManagedAdapterInstallError(
        "adapter_verification_failed",
        "The managed adapter did not match its pinned artifact",
        { cause: error },
      );
    }
    if (error.code === "managed_package_publish_failed") {
      return new ManagedAdapterInstallError(
        "adapter_publish_failed",
        "The managed adapter could not be published",
        { cause: error },
      );
    }
  }
  return new ManagedAdapterInstallError(
    "adapter_install_failed",
    "The pinned ACP adapter could not be installed",
    { cause: error },
  );
}

export async function validateManagedAdapter(
  root: string,
  specification: LocalAgentSpecification,
): Promise<ResolvedExecutable> {
  try {
    return await validateManagedNpmPackage(
      root,
      specification.adapterPackageDefinition,
    );
  } catch (error) {
    throw translateError(error);
  }
}

export interface ManagedAdapterInstallerOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly stateDirectory: string;
}

export interface AdapterInstallationPort {
  readonly install: (
    specification: LocalAgentSpecification,
    signal: AbortSignal,
  ) => Promise<ResolvedExecutable>;
}

export class ManagedAdapterInstaller implements AdapterInstallationPort {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #npmInstaller: ManagedNpmPackageInstallationPort;
  readonly #stateDirectory: string;

  constructor(
    options: ManagedAdapterInstallerOptions,
    npmInstaller: ManagedNpmPackageInstallationPort = new ManagedNpmPackageInstaller(),
  ) {
    this.#environment = options.environment;
    this.#npmInstaller = npmInstaller;
    this.#stateDirectory = options.stateDirectory;
  }

  readonly install = async (
    specification: LocalAgentSpecification,
    signal: AbortSignal,
  ): Promise<ResolvedExecutable> => {
    const root = join(
      this.#stateDirectory,
      "adapters",
      specification.id,
      specification.adapterVersion,
    );
    try {
      return await this.#npmInstaller.install(
        root,
        specification.adapterPackageDefinition,
        this.#environment,
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      throw translateError(error);
    }
  };
}
