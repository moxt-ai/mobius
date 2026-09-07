import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type ResolvedExecutable,
  runBoundedProcess,
} from "../process/executable.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";
import { DEEPSEEK_HARNESS_PACKAGE } from "./deepseek-managed-package.ts";
import {
  type AgentInstallRecipeOptions,
  FixedAgentInstallRecipe,
} from "./fixed-agent-install-recipe.ts";
import { GrokBuildInstallRecipe } from "./grok-build-install-recipe.ts";
import {
  ManagedAgentArchiveError,
  type ManagedAgentArchiveInstallationPort,
  ManagedAgentArchiveInstaller,
} from "./managed-agent-archive.ts";
import {
  ManagedNpmPackageError,
  type ManagedNpmPackageInstallationPort,
  ManagedNpmPackageInstaller,
} from "./managed-npm-package.ts";
import {
  OPENCODE_MANAGED_VERSION,
  openCodeManagedArchive,
} from "./opencode-managed-release.ts";
import { PI_AGENT_PACKAGE } from "./pi-managed-packages.ts";
import { downloadVerifiedFile } from "./verified-download.ts";
import { WorkBuddyInstallRecipe } from "./workbuddy-install-recipe.ts";

const INSTALLER_DOWNLOAD_LIMIT_BYTES = 1024 * 1024;
const INSTALLER_DOWNLOAD_TIMEOUT_MILLISECONDS = 60_000;
const AGENT_INSTALL_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MINIMAL_PATH = "/usr/bin:/bin";

class CodexInstallRecipe extends FixedAgentInstallRecipe {
  readonly id = "codex";
  readonly label = "Codex";
  readonly releaseChannel = "latest";

  readonly install = async (
    options: AgentInstallRecipeOptions,
  ): Promise<ResolvedExecutable> => {
    this.assertSupportedPlatform();
    const root = join(options.stateDirectory, "agents", this.id);
    const temporaryRoot = join(options.stateDirectory, "temporary");
    await Promise.all([
      mkdir(root, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const temporaryDirectory = await mkdtemp(
      join(temporaryRoot, ".codex-install-"),
    );
    const installerPath = join(temporaryDirectory, "install.sh");
    const installDirectory = join(root, "bin");
    const codexHome = join(root, "home");
    try {
      await Promise.all([
        mkdir(installDirectory, { mode: 0o700, recursive: true }),
        mkdir(codexHome, { mode: 0o700, recursive: true }),
      ]);
      await options.report("downloading");
      const download = await downloadVerifiedFile({
        allowedHosts: new Set(["chatgpt.com", "releases.openai.com"]),
        destination: installerPath,
        maximumBytes: INSTALLER_DOWNLOAD_LIMIT_BYTES,
        signal: options.signal,
        timeoutMilliseconds: INSTALLER_DOWNLOAD_TIMEOUT_MILLISECONDS,
        url: new URL("https://chatgpt.com/codex/install.sh"),
      });
      options.audit.record(
        "agent_installer_download_verified",
        options.requestId,
        this.id,
        {
          bytes: download.bytes.toString(),
          releaseChannel: this.releaseChannel,
          sha256: download.sha256,
        },
      );
      await options.report("verifying");
      await options.report("installing_agent");
      await runBoundedProcess({
        arguments: [installerPath],
        command: "/bin/sh",
        cwd: temporaryDirectory,
        environment: {
          CODEX_HOME: codexHome,
          CODEX_INSTALL_DIR: installDirectory,
          CODEX_NON_INTERACTIVE: "1",
          CODEX_RELEASE: this.releaseChannel,
          HOME: codexHome,
          PATH: MINIMAL_PATH,
        },
        outputLimitBytes: 64 * 1024,
        signal: options.signal,
        timeoutMilliseconds: AGENT_INSTALL_TIMEOUT_MILLISECONDS,
      });
      return await this.requireInstalledExecutable(
        join(installDirectory, "codex"),
      );
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      if (
        error instanceof InstallationManagerError ||
        (error instanceof Error && "code" in error)
      ) {
        throw error;
      }
      throw new InstallationManagerError(
        "agent_install_failed",
        "The fixed Codex installation recipe failed",
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  };
}

class ClaudeCodeInstallRecipe extends FixedAgentInstallRecipe {
  readonly id = "claude";
  readonly label = "Claude Code";
  readonly releaseChannel = "stable";

  readonly install = async (
    options: AgentInstallRecipeOptions,
  ): Promise<ResolvedExecutable> => {
    this.assertSupportedPlatform();
    const root = join(options.stateDirectory, "agents", this.id);
    const managedHome = join(root, "home");
    const temporaryRoot = join(options.stateDirectory, "temporary");
    await Promise.all([
      mkdir(managedHome, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const temporaryDirectory = await mkdtemp(
      join(temporaryRoot, ".claude-install-"),
    );
    const installerPath = join(temporaryDirectory, "install.sh");
    try {
      await options.report("downloading");
      const download = await downloadVerifiedFile({
        allowedHosts: new Set(["claude.ai"]),
        destination: installerPath,
        maximumBytes: INSTALLER_DOWNLOAD_LIMIT_BYTES,
        signal: options.signal,
        timeoutMilliseconds: INSTALLER_DOWNLOAD_TIMEOUT_MILLISECONDS,
        url: new URL("https://claude.ai/install.sh"),
      });
      options.audit.record(
        "agent_installer_download_verified",
        options.requestId,
        this.id,
        {
          bytes: download.bytes.toString(),
          releaseChannel: this.releaseChannel,
          sha256: download.sha256,
        },
      );
      await options.report("verifying");
      await options.report("installing_agent");
      await runBoundedProcess({
        arguments: [installerPath, "stable"],
        command: "/bin/bash",
        cwd: temporaryDirectory,
        environment: {
          HOME: managedHome,
          PATH: MINIMAL_PATH,
          SHELL: "/bin/bash",
        },
        outputLimitBytes: 64 * 1024,
        signal: options.signal,
        timeoutMilliseconds: AGENT_INSTALL_TIMEOUT_MILLISECONDS,
      });
      return await this.requireInstalledExecutable(
        join(managedHome, ".local", "bin", "claude"),
      );
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      if (
        error instanceof InstallationManagerError ||
        (error instanceof Error && "code" in error)
      ) {
        throw error;
      }
      throw new InstallationManagerError(
        "agent_install_failed",
        "The fixed Claude Code installation recipe failed",
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  };
}

class PiInstallRecipe extends FixedAgentInstallRecipe {
  readonly #npmInstaller: ManagedNpmPackageInstallationPort;
  readonly id = "pi";
  readonly label = "Pi";
  readonly releaseChannel = PI_AGENT_PACKAGE.version;

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
          PI_AGENT_PACKAGE.version,
        ),
        PI_AGENT_PACKAGE,
        options.environment,
        options.signal,
      );
      options.audit.record(
        "agent_npm_package_verified",
        options.requestId,
        this.id,
        {
          integrity: PI_AGENT_PACKAGE.integrity,
          package: PI_AGENT_PACKAGE.packageName,
          version: PI_AGENT_PACKAGE.version,
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
            "The managed Pi package did not match its pinned artifact",
            { cause: error },
          );
        }
        if (error.code === "managed_package_publish_failed") {
          throw new InstallationManagerError(
            "agent_publish_failed",
            "The managed Pi package could not be published",
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
        "The fixed Pi installation recipe failed",
        { cause: error },
      );
    }
  };
}

export class DeepSeekHarnessInstallRecipe extends FixedAgentInstallRecipe {
  readonly #npmInstaller: ManagedNpmPackageInstallationPort;
  readonly id = "deepseek-harness";
  readonly label = "DeepSeek Harness";
  readonly releaseChannel = DEEPSEEK_HARNESS_PACKAGE.version;

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
      const managedHome = join(
        options.stateDirectory,
        "agents",
        this.id,
        "home",
      );
      await mkdir(managedHome, { mode: 0o700, recursive: true });
      await options.report("downloading");
      await options.report("verifying");
      await options.report("installing_agent");
      const executable = await this.#npmInstaller.install(
        join(
          options.stateDirectory,
          "agents",
          this.id,
          DEEPSEEK_HARNESS_PACKAGE.version,
        ),
        DEEPSEEK_HARNESS_PACKAGE,
        options.environment,
        options.signal,
      );
      options.audit.record(
        "agent_npm_package_verified",
        options.requestId,
        this.id,
        {
          integrity: DEEPSEEK_HARNESS_PACKAGE.integrity,
          package: DEEPSEEK_HARNESS_PACKAGE.packageName,
          version: DEEPSEEK_HARNESS_PACKAGE.version,
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
            "The managed DeepSeek Harness package did not match its pinned artifact",
            { cause: error },
          );
        }
        if (error.code === "managed_package_publish_failed") {
          throw new InstallationManagerError(
            "agent_publish_failed",
            "The managed DeepSeek Harness package could not be published",
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
        "The fixed DeepSeek Harness installation recipe failed",
        { cause: error },
      );
    }
  };
}

export class OpenCodeInstallRecipe extends FixedAgentInstallRecipe {
  readonly #archiveInstaller: ManagedAgentArchiveInstallationPort;
  readonly id = "opencode";
  readonly label = "OpenCode";
  readonly releaseChannel = OPENCODE_MANAGED_VERSION;

  constructor(
    archiveInstaller: ManagedAgentArchiveInstallationPort = new ManagedAgentArchiveInstaller(),
  ) {
    super();
    this.#archiveInstaller = archiveInstaller;
  }

  readonly install = async (
    options: AgentInstallRecipeOptions,
  ): Promise<ResolvedExecutable> => {
    this.assertSupportedPlatform();
    const definition = openCodeManagedArchive(process.platform, process.arch);
    try {
      await options.report("downloading");
      await options.report("verifying");
      await options.report("installing_agent");
      const executable = await this.#archiveInstaller.install(
        join(
          options.stateDirectory,
          "agents",
          this.id,
          OPENCODE_MANAGED_VERSION,
        ),
        definition,
        options.signal,
      );
      options.audit.record(
        "agent_archive_verified",
        options.requestId,
        this.id,
        {
          sha256: definition.archiveSha256,
          version: definition.version,
        },
      );
      return executable;
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      if (error instanceof ManagedAgentArchiveError) {
        if (error.code === "managed_archive_verification_failed") {
          throw new InstallationManagerError(
            "agent_verification_failed",
            "The managed OpenCode archive did not match its pinned artifact",
            { cause: error },
          );
        }
        if (error.code === "managed_archive_publish_failed") {
          throw new InstallationManagerError(
            "agent_publish_failed",
            "The managed OpenCode archive could not be published",
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
        "The fixed OpenCode installation recipe failed",
        { cause: error },
      );
    }
  };
}

export function fixedAgentInstallRecipes(): readonly FixedAgentInstallRecipe[] {
  return Object.freeze([
    new CodexInstallRecipe(),
    new ClaudeCodeInstallRecipe(),
    new PiInstallRecipe(),
    new DeepSeekHarnessInstallRecipe(),
    new OpenCodeInstallRecipe(),
    new GrokBuildInstallRecipe(),
    new WorkBuddyInstallRecipe(),
  ]);
}

export type { AgentInstallRecipeOptions } from "./fixed-agent-install-recipe.ts";
export { FixedAgentInstallRecipe } from "./fixed-agent-install-recipe.ts";
export { GrokBuildInstallRecipe } from "./grok-build-install-recipe.ts";
export { WorkBuddyInstallRecipe } from "./workbuddy-install-recipe.ts";
