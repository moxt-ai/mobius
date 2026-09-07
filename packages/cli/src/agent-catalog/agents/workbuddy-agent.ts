import { join } from "node:path";

import type {
  AgentCapabilities,
  ClientConnection,
  InitializeResponse,
} from "@agentclientprotocol/sdk";
import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import {
  WORKBUDDY_MANAGED_PACKAGE,
  WORKBUDDY_MANAGED_VERSION,
} from "../../agent-installation/workbuddy-managed-package.ts";
import type { ResolvedExecutable } from "../../process/executable.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

export class WorkBuddyAgentSpecification extends DirectAcpAgentDefinition {
  readonly adapterVersion = WORKBUDDY_MANAGED_VERSION;
  override readonly authenticationCommand = (): string => "codebuddy";
  readonly agentExecutable = "codebuddy";
  readonly id = "workbuddy";
  readonly label = "WorkBuddy";

  constructor() {
    super(
      "MOBIUS_WORKBUDDY_PATH",
      ["--acp"],
      [
        "agents",
        "workbuddy",
        WORKBUDDY_MANAGED_VERSION,
        "node_modules",
        "@tencent-ai",
        "codebuddy-code",
        "bin",
        "codebuddy",
      ],
    );
  }

  override readonly createLaunchEnvironment = (): Promise<
    Readonly<Record<string, string>>
  > => Promise.resolve(Object.freeze({ DISABLE_AUTOUPDATER: "1" }));

  override readonly resolveManagedAgent = async (
    stateDirectory: string,
    _platform: NodeJS.Platform,
    signal: AbortSignal,
  ): Promise<ResolvedExecutable> => {
    signal.throwIfAborted();
    const executable = await validateManagedNpmPackage(
      join(stateDirectory, "agents", this.id, WORKBUDDY_MANAGED_VERSION),
      WORKBUDDY_MANAGED_PACKAGE,
    );
    signal.throwIfAborted();
    return executable;
  };

  override readonly verifyAcp = async (
    connection: ClientConnection,
    initialized: InitializeResponse,
    defaultWorkspace: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
    if (
      capabilities.loadSession !== true ||
      (initialized.authMethods ?? []).length === 0
    ) {
      throw new AgentProbeError(
        "acp_incompatible",
        "WorkBuddy reported an unsupported ACP capability set",
      );
    }
    await verifySessionCreation(
      connection,
      capabilities,
      defaultWorkspace,
      signal,
      this.label,
    );
  };
}
