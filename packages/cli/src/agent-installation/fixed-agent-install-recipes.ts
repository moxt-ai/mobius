import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentInstallationStage } from "@moxt-ai/mobius-protocol";
import {
  type ResolvedExecutable,
  resolveExecutablePath,
  runBoundedProcess,
} from "../process/executable.ts";
import type { InstallationAudit } from "./agent-installation-manager.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";
import { downloadVerifiedFile } from "./verified-download.ts";

const INSTALLER_DOWNLOAD_LIMIT_BYTES = 1024 * 1024;
const INSTALLER_DOWNLOAD_TIMEOUT_MILLISECONDS = 60_000;
const AGENT_INSTALL_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MINIMAL_PATH = "/usr/bin:/bin";

export interface AgentInstallRecipeOptions {
  readonly audit: InstallationAudit;
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

export function fixedAgentInstallRecipes(): readonly FixedAgentInstallRecipe[] {
  return Object.freeze([
    new CodexInstallRecipe(),
    new ClaudeCodeInstallRecipe(),
  ]);
}
