import type { AgentInstallationStage } from "@moxt-ai/mobius-protocol";

import {
  type ResolvedExecutable,
  resolveExecutablePath,
} from "../process/executable.ts";
import type { InstallationAudit } from "./agent-installation-manager.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";

export interface AgentInstallRecipeOptions {
  readonly audit: InstallationAudit;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly report: (stage: AgentInstallationStage) => Promise<void>;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly stateDirectory: string;
}

export abstract class FixedAgentInstallRecipe {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly releaseChannel: string;
  abstract readonly install: (
    options: AgentInstallRecipeOptions,
  ) => Promise<ResolvedExecutable>;

  protected readonly assertSupportedPlatform = (): void => {
    if (
      (process.platform !== "darwin" && process.platform !== "linux") ||
      (process.arch !== "arm64" && process.arch !== "x64")
    ) {
      throw new InstallationManagerError(
        "unsupported_install_platform",
        "This Agent installation recipe does not support the local platform",
      );
    }
  };

  protected readonly requireInstalledExecutable = async (
    path: string,
  ): Promise<ResolvedExecutable> => {
    const executable = await resolveExecutablePath(path);
    if (executable === null) {
      throw new InstallationManagerError(
        "agent_verification_failed",
        "The Agent installer did not produce a valid executable",
      );
    }
    return executable;
  };
}
