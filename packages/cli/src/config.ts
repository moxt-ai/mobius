import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function adapterEntrypoint(packageName: string): string {
  return fileURLToPath(new URL("./index.js", import.meta.resolve(packageName)));
}

export class LocalAgentDefinition {
  readonly arguments: readonly string[];
  readonly command: string;
  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    command: string,
    arguments_: readonly string[],
  ) {
    this.id = id;
    this.label = label;
    this.command = command;
    this.arguments = arguments_;
  }
}

export interface DaemonConfig {
  readonly agents: readonly LocalAgentDefinition[];
  readonly approvedRoot: string;
  readonly auditDatabasePath: string;
  readonly bindingId: string;
  readonly channelId: string;
  readonly relayUrl: URL;
}

export interface DaemonConnectionConfig {
  readonly approvedRoot: string;
  readonly auditDatabasePath: string;
  readonly channelId: string;
  readonly relayUrl: URL;
}

export function loadLocalAgents(): readonly LocalAgentDefinition[] {
  // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
  const overridePath = process.env["MOBIUS_ACP_AGENT_PATH"]?.trim();
  if (overridePath !== undefined && overridePath.length > 0) {
    return [
      new LocalAgentDefinition("codex", "Codex", process.execPath, [
        overridePath,
        "--agent-name",
        "Codex",
      ]),
      new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
        overridePath,
        "--agent-name",
        "Claude Code",
      ]),
    ];
  }

  return [
    new LocalAgentDefinition("codex", "Codex", process.execPath, [
      adapterEntrypoint("@agentclientprotocol/codex-acp"),
    ]),
    new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
      adapterEntrypoint("@agentclientprotocol/claude-agent-acp"),
    ]),
  ];
}

export function createDaemonConfig(
  connection: DaemonConnectionConfig,
): DaemonConfig {
  return {
    agents: loadLocalAgents(),
    approvedRoot: connection.approvedRoot,
    auditDatabasePath: connection.auditDatabasePath,
    bindingId: "workspace",
    channelId: connection.channelId,
    relayUrl: connection.relayUrl,
  };
}

export function findLocalAgent(
  agents: readonly LocalAgentDefinition[],
  agentId: string,
): LocalAgentDefinition {
  for (const agent of agents) {
    if (agent.id === agentId) {
      return agent;
    }
  }
  throw new Error("The requested local agent is not approved");
}

export function loadDaemonConfig(): DaemonConfig {
  const relayUrl = new URL(
    // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
    process.env["MOBIUS_RELAY_URL"] ??
      "ws://127.0.0.1:8787/v1/channels/local/daemon",
  );
  relayUrl.searchParams.set(
    "token",
    // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
    process.env["MOBIUS_RELAY_TOKEN"] ?? "local-development-token",
  );

  if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
    throw new Error("MOBIUS_RELAY_URL must use ws or wss");
  }

  return createDaemonConfig({
    // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
    approvedRoot: process.env["MOBIUS_APPROVED_ROOT"] ?? repositoryRoot,
    auditDatabasePath:
      // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
      process.env["MOBIUS_AUDIT_DATABASE"] ??
      fileURLToPath(new URL("../../../.mobius/daemon.sqlite", import.meta.url)),
    // biome-ignore lint/complexity/useLiteralKeys: Environment variables use an index signature.
    channelId: process.env["MOBIUS_CHANNEL_ID"] ?? "local",
    relayUrl,
  });
}
