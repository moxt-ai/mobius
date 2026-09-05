export const PAIRING_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export interface AgentDescriptor {
  readonly id: string;
  readonly label: string;
}

export interface InstallableAgentDescriptor {
  readonly id: string;
  readonly label: string;
  readonly requiresLocalApproval: boolean;
}

export interface CreatedPairing {
  readonly channelId: string;
  readonly expiresAt: string;
  readonly pairingCode: string;
  readonly pairingId: string;
  readonly pollToken: string;
}

export interface ClaimedPairing {
  readonly channelId: string;
  readonly daemonToken: string;
}

export class ChannelDescriptor {
  readonly agents: readonly AgentDescriptor[];
  readonly channelId: string;
  readonly installableAgents: readonly InstallableAgentDescriptor[];
  readonly machineName: string;
  readonly workspaceName: string;

  constructor(
    agents: readonly AgentDescriptor[],
    channelId: string,
    machineName: string,
    workspaceName: string,
    installableAgents: readonly InstallableAgentDescriptor[] = [],
  ) {
    this.agents = agents;
    this.channelId = channelId;
    this.installableAgents = installableAgents;
    this.machineName = machineName;
    this.workspaceName = workspaceName;
  }
}

export abstract class PairingStatus {
  abstract readonly status: string;
}

export class PendingPairingStatus extends PairingStatus {
  readonly expiresAt: string;
  readonly status = "pending";

  constructor(expiresAt: string) {
    super();
    this.expiresAt = expiresAt;
  }
}

export class ExpiredPairingStatus extends PairingStatus {
  readonly status = "expired";
}

export class PairedPairingStatus extends PairingStatus {
  readonly agents: readonly AgentDescriptor[];
  readonly channelId: string;
  readonly installableAgents: readonly InstallableAgentDescriptor[];
  readonly machineName: string;
  readonly status = "paired";
  readonly workspaceName: string;

  constructor(
    agents: readonly AgentDescriptor[],
    channelId: string,
    machineName: string,
    workspaceName: string,
    installableAgents: readonly InstallableAgentDescriptor[] = [],
  ) {
    super();
    this.agents = agents;
    this.channelId = channelId;
    this.installableAgents = installableAgents;
    this.machineName = machineName;
    this.workspaceName = workspaceName;
  }
}

export class PairingDirectoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "PairingDirectoryError";
  }
}

export interface PairingDirectory {
  readonly authorizeDaemon: (
    channelId: string,
    token: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly authorizeHost: (
    channelId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly claimPairing: (
    pairingCode: string,
    machineName: string,
    workspaceName: string,
    agents: readonly AgentDescriptor[],
    installableAgents: readonly InstallableAgentDescriptor[],
    signal: AbortSignal,
  ) => Promise<ClaimedPairing>;
  readonly createPairing: (signal: AbortSignal) => Promise<CreatedPairing>;
  readonly readChannel: (
    channelId: string,
    signal: AbortSignal,
  ) => Promise<ChannelDescriptor>;
  readonly readPairingStatus: (
    pairingId: string,
    pollToken: string,
    signal: AbortSignal,
  ) => Promise<PairingStatus>;
  readonly updateAgentCatalog: (
    channelId: string,
    token: string,
    agents: readonly AgentDescriptor[],
    installableAgents: readonly InstallableAgentDescriptor[],
    signal: AbortSignal,
  ) => Promise<void>;
}

export function createRandomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createRandomPairingCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
  }
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function normalizePairingCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!PAIRING_CODE_PATTERN.test(normalized)) {
    throw new PairingDirectoryError(
      "invalid_pairing_code",
      "The pairing code is invalid or expired",
    );
  }
  return normalized;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function parseAgents(encoded: string): readonly AgentDescriptor[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new PairingDirectoryError(
      "invalid_directory_record",
      "The paired agent directory is invalid",
      { cause: error },
    );
  }
  return validateAgents(value);
}

export function parseInstallableAgents(
  encoded: string,
): readonly InstallableAgentDescriptor[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new PairingDirectoryError(
      "invalid_directory_record",
      "The installable Agent directory is invalid",
      { cause: error },
    );
  }
  return validateInstallableAgents(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAgents(value: unknown): readonly AgentDescriptor[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new PairingDirectoryError(
      "invalid_agents",
      "The ready Agent directory is invalid",
    );
  }

  const agents: AgentDescriptor[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      !Object.hasOwn(candidate, "id") ||
      !Object.hasOwn(candidate, "label")
    ) {
      throw new PairingDirectoryError(
        "invalid_agents",
        "The local agent directory is invalid",
      );
    }
    const id = candidate["id"];
    const label = candidate["label"];
    if (
      typeof id !== "string" ||
      !IDENTIFIER_PATTERN.test(id) ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80 ||
      identifiers.has(id)
    ) {
      throw new PairingDirectoryError(
        "invalid_agents",
        "The local agent directory is invalid",
      );
    }
    identifiers.add(id);
    agents.push({ id, label: label.trim() });
  }
  return agents;
}

export function validateInstallableAgents(
  value: unknown,
): readonly InstallableAgentDescriptor[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new PairingDirectoryError(
      "invalid_agents",
      "The installable Agent directory is invalid",
    );
  }
  const agents: InstallableAgentDescriptor[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 3 ||
      !Object.hasOwn(candidate, "id") ||
      !Object.hasOwn(candidate, "label") ||
      !Object.hasOwn(candidate, "requiresLocalApproval")
    ) {
      throw new PairingDirectoryError(
        "invalid_agents",
        "The installable Agent directory is invalid",
      );
    }
    const id = candidate["id"];
    const label = candidate["label"];
    const requiresLocalApproval = candidate["requiresLocalApproval"];
    if (
      typeof id !== "string" ||
      !IDENTIFIER_PATTERN.test(id) ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80 ||
      typeof requiresLocalApproval !== "boolean" ||
      identifiers.has(id)
    ) {
      throw new PairingDirectoryError(
        "invalid_agents",
        "The installable Agent directory is invalid",
      );
    }
    identifiers.add(id);
    agents.push({ id, label: label.trim(), requiresLocalApproval });
  }
  return agents;
}

export function validateAgentCatalog(
  agents: readonly AgentDescriptor[],
  installableAgents: readonly InstallableAgentDescriptor[],
): void {
  if (agents.length + installableAgents.length === 0) {
    throw new PairingDirectoryError(
      "invalid_agents",
      "At least one ready or installable local Agent is required",
    );
  }
  const readyIds = new Set(agents.map((agent) => agent.id));
  if (installableAgents.some((agent) => readyIds.has(agent.id))) {
    throw new PairingDirectoryError(
      "invalid_agents",
      "An Agent cannot be both ready and installable",
    );
  }
}

export function validateDisplayName(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PairingDirectoryError(
      `invalid_${field}`,
      `The ${field.replaceAll("_", " ")} is invalid`,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120) {
    throw new PairingDirectoryError(
      `invalid_${field}`,
      `The ${field.replaceAll("_", " ")} is invalid`,
    );
  }
  return normalized;
}

export function validatePairingCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new PairingDirectoryError(
      "invalid_pairing_code",
      "The pairing code is invalid or expired",
    );
  }
  return normalizePairingCode(value);
}

export function validateIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new PairingDirectoryError(
      `invalid_${field}`,
      `The ${field.replaceAll("_", " ")} is invalid`,
    );
  }
  return value;
}

export function validateToken(value: string): string {
  if (!TOKEN_PATTERN.test(value)) {
    throw new PairingDirectoryError(
      "unauthorized",
      "A valid channel token is required",
    );
  }
  return value;
}
