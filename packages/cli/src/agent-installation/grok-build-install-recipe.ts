import { mkdir, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { ResolvedExecutable } from "../process/executable.ts";
import { runBoundedProcess } from "../process/executable.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";
import {
  type AgentInstallRecipeOptions,
  FixedAgentInstallRecipe,
} from "./fixed-agent-install-recipe.ts";
import {
  GROK_BUILD_MANAGED_VERSION,
  grokBuildManagedPackage,
} from "./grok-managed-package.ts";
import {
  ManagedNpmPackageError,
  type ManagedNpmPackageInstallationPort,
  ManagedNpmPackageInstaller,
} from "./managed-npm-package.ts";

const INSTALL_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;

function isContainedPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function resolveLifecycleScript(packageRoot: string): Promise<string> {
  try {
    const canonicalPackageRoot = await realpath(packageRoot);
    const script = await realpath(
      join(canonicalPackageRoot, "bin", "postinstall.js"),
    );
    const metadata = await stat(script);
    if (!metadata.isFile() || !isContainedPath(canonicalPackageRoot, script)) {
      throw new Error("Invalid Grok Build lifecycle script");
    }
    return script;
  } catch (error) {
    throw new InstallationManagerError(
      "agent_verification_failed",
      "The managed Grok Build lifecycle script is invalid",
      { cause: error },
    );
  }
}

export class GrokBuildInstallRecipe extends FixedAgentInstallRecipe {
  readonly #npmInstaller: ManagedNpmPackageInstallationPort;
  readonly id = "grok-build";
  readonly label = "Grok Build";
  readonly releaseChannel = GROK_BUILD_MANAGED_VERSION;

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
    const definition = grokBuildManagedPackage(process.platform, process.arch);
    const versionRoot = join(
      options.stateDirectory,
      "agents",
      this.id,
      GROK_BUILD_MANAGED_VERSION,
    );
    const packageRoot = join(versionRoot, "package");
    const managedHome = join(versionRoot, "home");
    try {
      await mkdir(managedHome, { mode: 0o700, recursive: true });
      const canonicalHome = await realpath(managedHome);
      await options.report("downloading");
      await options.report("verifying");
      await options.report("installing_agent");
      await this.#npmInstaller.install(
        packageRoot,
        definition,
        options.environment,
        options.signal,
      );
      options.audit.record(
        "agent_npm_package_verified",
        options.requestId,
        this.id,
        {
          integrity: definition.integrity,
          package: definition.packageName,
          version: definition.version,
        },
      );
      const script = await resolveLifecycleScript(
        join(packageRoot, "node_modules", "@xai-official", "grok"),
      );
      await runBoundedProcess({
        arguments: [script],
        command: process.execPath,
        cwd: dirname(script),
        environment: {
          GROK_HOME: canonicalHome,
          GROK_INSTALL_COMPLETIONS: "0",
          GROK_NPM_REGISTRY: "https://registry.npmjs.org/",
          HOME: canonicalHome,
          PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
        },
        outputLimitBytes: 64 * 1024,
        signal: options.signal,
        timeoutMilliseconds: INSTALL_TIMEOUT_MILLISECONDS,
      });
      options.audit.record(
        "agent_lifecycle_step_completed",
        options.requestId,
        this.id,
        {
          lifecycle: "postinstall",
          package: definition.packageName,
          version: definition.version,
        },
      );
      return await this.requireInstalledExecutable(
        join(canonicalHome, "bin", "grok"),
      );
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      if (error instanceof ManagedNpmPackageError) {
        if (error.code === "managed_package_verification_failed") {
          throw new InstallationManagerError(
            "agent_verification_failed",
            "The managed Grok Build packages did not match their pinned artifacts",
            { cause: error },
          );
        }
        if (error.code === "managed_package_publish_failed") {
          throw new InstallationManagerError(
            "agent_publish_failed",
            "The managed Grok Build package could not be published",
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
        "The fixed Grok Build installation recipe failed",
        { cause: error },
      );
    }
  };
}
