import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type {
  AgentCapabilities,
  ClientConnection,
  InitializeResponse,
} from "@agentclientprotocol/sdk";

import { DEEPSEEK_HARNESS_PACKAGE } from "../../agent-installation/deepseek-managed-package.ts";
import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import type { ResolvedExecutable } from "../../process/executable.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";

async function validateAgentHome(path: string): Promise<string> {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new AgentProbeError(
      "agent_environment_invalid",
      "The configured Agent home is invalid",
    );
  }
  try {
    const resolved = await realpath(path);
    const metadata = await stat(resolved);
    if (
      !metadata.isDirectory() ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new Error("Agent home is not a user-owned directory");
    }
    return resolved;
  } catch (error) {
    if (error instanceof AgentProbeError) {
      throw error;
    }
    throw new AgentProbeError(
      "agent_environment_invalid",
      "The configured Agent home is invalid",
      { cause: error },
    );
  }
}

export class DeepSeekHarnessAgentSpecification extends DirectAcpAgentDefinition {
  readonly adapterVersion = DEEPSEEK_HARNESS_PACKAGE.version;
  override readonly authenticationCommand = (): string => "dsh web";
  readonly agentExecutable = "dsh";
  readonly id = "deepseek-harness";
  readonly label = "DeepSeek Harness";

  constructor() {
    super(
      "MOBIUS_DEEPSEEK_HARNESS_PATH",
      ["--profile", "acp"],
      [
        "agents",
        "deepseek-harness",
        DEEPSEEK_HARNESS_PACKAGE.version,
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "lib",
        "bin.js",
      ],
    );
  }

  override readonly createLaunchEnvironment = async (
    agent: ResolvedExecutable,
    context: LocalAgentDiscoveryContext,
  ): Promise<Readonly<Record<string, string>>> => {
    let selectedHome = context.environment["DSH_HOME"];
    try {
      const managed = await this.resolveManagedAgent(
        readStateDirectory(context.environment),
        context.platform ?? process.platform,
        context.signal,
      );
      if (managed.path === agent.path) {
        selectedHome = join(
          readStateDirectory(context.environment),
          "agents",
          this.id,
          "home",
        );
      }
    } catch {
      context.signal.throwIfAborted();
      // An unavailable managed package cannot select the managed DSH home.
    }
    if (selectedHome === undefined || selectedHome.length === 0) {
      return Object.freeze({ DSH_PERMISSION_MODE: "workspace-write" });
    }
    return Object.freeze({
      DSH_HOME: await validateAgentHome(selectedHome),
      DSH_PERMISSION_MODE: "workspace-write",
    });
  };

  override readonly resolveManagedAgent = async (
    stateDirectory: string,
    _platform: NodeJS.Platform,
    signal: AbortSignal,
  ): Promise<ResolvedExecutable> => {
    signal.throwIfAborted();
    const executable = await validateManagedNpmPackage(
      join(stateDirectory, "agents", this.id, DEEPSEEK_HARNESS_PACKAGE.version),
      DEEPSEEK_HARNESS_PACKAGE,
    );
    signal.throwIfAborted();
    return executable;
  };

  override readonly verifyAcp = (
    _connection: ClientConnection,
    initialized: InitializeResponse,
    _defaultWorkspace: string,
    _signal: AbortSignal,
  ): Promise<void> => {
    const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
    const session = capabilities.sessionCapabilities;
    const prompt = capabilities.promptCapabilities;
    if (
      (initialized.authMethods ?? []).length !== 0 ||
      capabilities.loadSession === true ||
      capabilities.mcpCapabilities?.http !== true ||
      session?.close == null ||
      session.list == null ||
      session.resume == null ||
      session.additionalDirectories != null ||
      session.delete != null ||
      session.fork != null ||
      prompt?.audio === true ||
      prompt?.embeddedContext === true ||
      prompt?.image === true
    ) {
      throw new AgentProbeError(
        "acp_incompatible",
        "DeepSeek Harness reported an unsupported ACP capability set",
      );
    }
    return Promise.resolve();
  };
}
