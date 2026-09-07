import { join } from "node:path";

import type { ResolvedExecutable } from "../process/executable.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";
import {
  type AgentInstallRecipeOptions,
  FixedAgentInstallRecipe,
} from "./fixed-agent-install-recipe.ts";
import {
  ManagedNpmPackageError,
  type ManagedNpmPackageInstallationPort,
  ManagedNpmPackageInstaller,
} from "./managed-npm-package.ts";
import {
  WORKBUDDY_MANAGED_PACKAGE,
  WORKBUDDY_MANAGED_VERSION,
} from "./workbuddy-managed-package.ts";

export class WorkBuddyInstallRecipe extends FixedAgentInstallRecipe {
  readonly #npmInstaller: ManagedNpmPackageInstallationPort;
  readonly id = "workbuddy";
  readonly label = "WorkBuddy";
  readonly releaseChannel = WORKBUDDY_MANAGED_VERSION;

  constructor(
    npmInstaller: ManagedNpmPackageInstallationPort = new ManagedNpmPackageInstaller(),
  ) {
    super();
    this.#npmInstaller = npmInstaller;
  }

  readonly install = async (
    options: AgentInstallRecipeOptions,
  ): Promise<ResolvedExecutable> => {
    this.assertSupportedPlatform();
    try {
      await options.report("downloading");
      await options.report("verifying");
      await options.report("installing_agent");
      const executable = await this.#npmInstaller.install(
        join(
          options.stateDirectory,
          "agents",
          this.id,
          WORKBUDDY_MANAGED_VERSION,
        ),
        WORKBUDDY_MANAGED_PACKAGE,
        options.environment,
        options.signal,
      );
      options.audit.record(
        "agent_npm_package_verified",
        options.requestId,
        this.id,
        {
          integrity: WORKBUDDY_MANAGED_PACKAGE.integrity,
          package: WORKBUDDY_MANAGED_PACKAGE.packageName,
          version: WORKBUDDY_MANAGED_PACKAGE.version,
        },
      );
      return executable;
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      if (error instanceof ManagedNpmPackageError) {
        if (error.code === "managed_package_verification_failed") {
          throw new InstallationManagerError(
            "agent_verification_failed",
            "The managed WorkBuddy package did not match its pinned artifact",
            { cause: error },
          );
        }
        if (error.code === "managed_package_publish_failed") {
          throw new InstallationManagerError(
            "agent_publish_failed",
            "The managed WorkBuddy package could not be published",
            { cause: error },
          );
        }
        throw new InstallationManagerError(error.code, error.message, {
          cause: error,
        });
      }
      if (error instanceof InstallationManagerError) {
        throw error;
      }
      throw new InstallationManagerError(
        "agent_install_failed",
        "The fixed WorkBuddy installation recipe failed",
        { cause: error },
      );
    }
  };
}
