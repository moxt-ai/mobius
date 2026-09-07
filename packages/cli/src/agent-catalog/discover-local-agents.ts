import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

import {
  type AgentCapabilities,
  type ClientConnection,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import {
  type AcpClientHandler,
  createAcpClient,
} from "../acp/create-client.ts";
import { readGrantedAgents } from "../agent-installation/installation-grants.ts";
import { validateManagedAdapter } from "../agent-installation/managed-adapter-installer.ts";
import {
  ManagedNpmPackageDefinition,
  validateManagedNpmPackage,
} from "../agent-installation/managed-npm-package.ts";
import {
  PI_ACP_PACKAGE,
  PI_AGENT_PACKAGE,
} from "../agent-installation/pi-managed-packages.ts";
import {
  findExecutableOnPath,
  ProcessExecutionError,
  type ResolvedExecutable,
  resolveExecutablePath,
  runBoundedProcess,
  stopProcessTree,
} from "../process/executable.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import {
  InstallableAgentDefinition,
  LocalAgentDefinition,
} from "./local-agent.ts";

const VERSION_PROBE_TIMEOUT_MILLISECONDS = 3_000;
const ACP_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const ACP_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_PROMPT_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;
const PI_ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;
const PI_PROMPT_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;

export abstract class LocalAgentSpecification {
  abstract readonly adapterEnvironmentVariable: string;
  abstract readonly adapterOverrideVariable: string;
  abstract readonly adapterPackageDefinition: ManagedNpmPackageDefinition;
  abstract readonly agentExecutable: string;
  abstract readonly agentOverrideVariable: string;
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly managedAdapterExecutablePath: readonly string[];
  abstract readonly managedAgentExecutablePath: readonly string[];
  readonly acpProbeTimeoutMilliseconds: number = ACP_PROBE_TIMEOUT_MILLISECONDS;
  readonly authenticationCommand = (): string => "";
  readonly adapterVersionArguments: readonly string[] = ["--version"];
  readonly agentVersionArguments: readonly string[] = ["--version"];
  readonly promptTimeoutMilliseconds: number =
    DEFAULT_PROMPT_TIMEOUT_MILLISECONDS;

  get adapterExecutable(): string {
    return this.adapterPackageDefinition.executableName;
  }

  get adapterPackage(): string {
    return this.adapterPackageDefinition.packageName;
  }

  get adapterVersion(): string {
    return this.adapterPackageDefinition.version;
  }

  readonly resolveManagedAgent = async (
    stateDirectory: string,
    platform: NodeJS.Platform,
  ): Promise<ResolvedExecutable> => {
    const executable = await resolveExecutablePath(
      join(stateDirectory, ...this.managedAgentExecutablePath),
      platform,
    );
    if (executable === null) {
      throw new Error("The managed Agent executable is unavailable");
    }
    return executable;
  };

  readonly recoveryCommand = (): string =>
    `npm install -g --omit=optional ${this.adapterPackage}@${this.adapterVersion}`;

  readonly supportsInstallation = (
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
  ): boolean =>
    (platform === "darwin" || platform === "linux") &&
    (architecture === "arm64" || architecture === "x64");

  readonly verifyAcp = (
    _connection: ClientConnection,
    _initialized: InitializeResponse,
    _defaultWorkspace: string,
    _signal: AbortSignal,
  ): Promise<void> => Promise.resolve();
}

abstract class BridgedAcpAgentDefinition extends LocalAgentSpecification {}

export class CodexAgentSpecification extends BridgedAcpAgentDefinition {
  readonly adapterEnvironmentVariable = "CODEX_PATH";
  readonly adapterOverrideVariable = "MOBIUS_CODEX_ACP_PATH";
  readonly adapterPackageDefinition = new ManagedNpmPackageDefinition(
    "@agentclientprotocol/codex-acp",
    "1.8.0",
    "codex-acp",
  );
  readonly agentExecutable = "codex";
  readonly agentOverrideVariable = "MOBIUS_CODEX_PATH";
  readonly id = "codex";
  readonly label = "Codex";
  readonly managedAdapterExecutablePath = [
    "adapters",
    "codex",
    "1.8.0",
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
    "index.js",
  ];
  readonly managedAgentExecutablePath = ["agents", "codex", "bin", "codex"];
}

class ClaudeCodeAgentSpecification extends BridgedAcpAgentDefinition {
  readonly adapterEnvironmentVariable = "CLAUDE_CODE_EXECUTABLE";
  readonly adapterOverrideVariable = "MOBIUS_CLAUDE_ACP_PATH";
  readonly adapterPackageDefinition = new ManagedNpmPackageDefinition(
    "@agentclientprotocol/claude-agent-acp",
    "0.73.0",
    "claude-agent-acp",
  );
  readonly agentExecutable = "claude";
  readonly agentOverrideVariable = "MOBIUS_CLAUDE_PATH";
  readonly id = "claude";
  readonly label = "Claude Code";
  readonly managedAdapterExecutablePath = [
    "adapters",
    "claude",
    "0.73.0",
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
    "index.js",
  ];
  readonly managedAgentExecutablePath = [
    "agents",
    "claude",
    "home",
    ".local",
    "bin",
    "claude",
  ];
}

export class PiAgentSpecification extends BridgedAcpAgentDefinition {
  override readonly acpProbeTimeoutMilliseconds =
    PI_ACP_PROBE_TIMEOUT_MILLISECONDS;
  readonly adapterEnvironmentVariable = "PI_ACP_PI_COMMAND";
  readonly adapterOverrideVariable = "MOBIUS_PI_ACP_PATH";
  readonly adapterPackageDefinition = PI_ACP_PACKAGE;
  override readonly adapterVersionArguments: readonly string[] = [];
  override readonly authenticationCommand = (): string =>
    "pi-acp --terminal-login";
  readonly agentExecutable = "pi";
  readonly agentOverrideVariable = "MOBIUS_PI_PATH";
  readonly id = "pi";
  readonly label = "Pi";
  readonly managedAdapterExecutablePath = [
    "adapters",
    "pi",
    PI_ACP_PACKAGE.version,
    "node_modules",
    "pi-acp",
    "dist",
    "index.js",
  ];
  readonly managedAgentExecutablePath = [
    "agents",
    "pi",
    PI_AGENT_PACKAGE.version,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  ];
  override readonly promptTimeoutMilliseconds = PI_PROMPT_TIMEOUT_MILLISECONDS;

  override readonly resolveManagedAgent = async (
    stateDirectory: string,
    _platform: NodeJS.Platform,
  ): Promise<ResolvedExecutable> =>
    await validateManagedNpmPackage(
      join(stateDirectory, "agents", this.id, PI_AGENT_PACKAGE.version),
      PI_AGENT_PACKAGE,
    );

  override readonly verifyAcp = async (
    connection: ClientConnection,
    initialized: InitializeResponse,
    defaultWorkspace: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
    if (capabilities.loadSession !== true) {
      throw new AgentProbeError(
        "acp_incompatible",
        "Pi ACP adapter does not support session recovery",
      );
    }
    const session = await connection.agent.request(
      methods.agent.session.new,
      {
        additionalDirectories: [],
        cwd: defaultWorkspace,
        mcpServers: [],
      },
      { cancellationSignal: signal },
    );
    if (session.sessionId.length === 0) {
      throw new AgentProbeError(
        "acp_incompatible",
        "Pi ACP adapter returned an invalid session",
      );
    }
    const prompt = await connection.agent.request(
      methods.agent.session.prompt,
      {
        prompt: [{ text: "/session", type: "text" }],
        sessionId: session.sessionId,
      },
      { cancellationSignal: signal },
    );
    if (prompt.stopReason !== "end_turn") {
      throw new AgentProbeError(
        "acp_incompatible",
        "Pi ACP adapter did not complete its conformance prompt",
      );
    }
  };
}

export function supportedLocalAgentSpecifications(): readonly LocalAgentSpecification[] {
  return Object.freeze([
    new CodexAgentSpecification(),
    new ClaudeCodeAgentSpecification(),
    new PiAgentSpecification(),
  ]);
}

export abstract class AgentDiscovery {
  readonly specification: LocalAgentSpecification;
  abstract readonly status: string;

  protected constructor(specification: LocalAgentSpecification) {
    this.specification = specification;
  }
}

export class AvailableAgent extends AgentDiscovery {
  readonly agent: LocalAgentDefinition;
  readonly status = "ready";

  constructor(
    specification: LocalAgentSpecification,
    agent: LocalAgentDefinition,
  ) {
    super(specification);
    this.agent = agent;
  }
}

export abstract class UnavailableAgent extends AgentDiscovery {
  abstract readonly code: string;
  abstract readonly message: string;
}

export class MissingAdapter extends UnavailableAgent {
  readonly code = "adapter_not_found";
  readonly message = "ACP adapter not found";
  readonly status = "missing_adapter";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

class MissingAgent extends UnavailableAgent {
  readonly code = "agent_not_found";
  readonly message = "Agent executable not found";
  readonly status = "missing_agent";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

class ProbeFailed extends UnavailableAgent {
  readonly code: string;
  readonly message: string;
  readonly status = "probe_failed";

  constructor(
    specification: LocalAgentSpecification,
    code: string,
    message: string,
  ) {
    super(specification);
    this.code = code;
    this.message = message;
  }
}

class IncompatibleAdapter extends UnavailableAgent {
  readonly code = "acp_incompatible";
  readonly message = "ACP adapter is incompatible";
  readonly status = "incompatible_adapter";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

class AuthenticationRequiredAgent extends UnavailableAgent {
  readonly code = "authentication_required";
  readonly message = "Agent authentication is required";
  readonly status = "authentication_required";

  constructor(specification: LocalAgentSpecification) {
    super(specification);
  }
}

export class LocalAgentInventory {
  readonly available: readonly AvailableAgent[];
  readonly discoveries: readonly AgentDiscovery[];
  readonly installable: readonly InstallableAgentDefinition[];
  readonly unavailable: readonly UnavailableAgent[];

  constructor(
    discoveries: readonly AgentDiscovery[],
    grantedAgents: ReadonlySet<string> = new Set<string>(),
    platform: NodeJS.Platform = process.platform,
    architecture: NodeJS.Architecture = process.arch,
  ) {
    const available: AvailableAgent[] = [];
    const unavailable: UnavailableAgent[] = [];
    for (const discovery of discoveries) {
      if (discovery instanceof AvailableAgent) {
        available.push(discovery);
      } else if (discovery instanceof UnavailableAgent) {
        unavailable.push(discovery);
      } else {
        throw new Error("Unsupported Agent discovery outcome");
      }
    }
    this.available = Object.freeze(available);
    this.discoveries = Object.freeze([...discoveries]);
    this.installable = Object.freeze(
      unavailable
        .filter(
          (discovery) =>
            !(discovery instanceof AuthenticationRequiredAgent) &&
            discovery.specification.supportsInstallation(
              platform,
              architecture,
            ),
        )
        .map(
          (discovery) =>
            new InstallableAgentDefinition(
              discovery.specification.id,
              discovery.specification.label,
              !grantedAgents.has(discovery.specification.id),
            ),
        ),
    );
    this.unavailable = Object.freeze(unavailable);
  }

  readonly readyAgents = (): readonly LocalAgentDefinition[] =>
    this.available.map((discovery) => discovery.agent);
}

export interface DiscoverLocalAgentInventoryOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly defaultWorkspace: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly specifications?: readonly LocalAgentSpecification[];
}

class AgentProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "AgentProbeError";
  }
}

class DiscoveryAcpHandler implements AcpClientHandler {
  readonly onElicitation = (
    _request: CreateElicitationRequest,
    _signal: AbortSignal,
  ): Promise<CreateElicitationResponse> =>
    Promise.reject(new Error("ACP probe does not accept elicitations"));

  readonly onElicitationComplete = (
    _notification: CompleteElicitationNotification,
  ): Promise<void> => Promise.resolve();

  readonly onPermission = (
    _request: RequestPermissionRequest,
    _signal: AbortSignal,
  ): Promise<RequestPermissionResponse> =>
    Promise.reject(new Error("ACP probe does not grant permissions"));

  readonly onUpdate = (_notification: SessionNotification): Promise<void> =>
    Promise.resolve();
}

async function resolveManagedExecutable(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<ResolvedExecutable | null> {
  try {
    return await specification.resolveManagedAgent(
      readStateDirectory(options.environment),
      options.platform ?? process.platform,
    );
  } catch {
    return null;
  }
}

async function resolveManagedAdapterExecutable(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<ResolvedExecutable | null> {
  let managed: ResolvedExecutable;
  try {
    managed = await validateManagedAdapter(
      join(
        readStateDirectory(options.environment),
        "adapters",
        specification.id,
        specification.adapterVersion,
      ),
      specification,
    );
  } catch {
    return null;
  }
  return managed;
}

async function resolveSpecificationExecutables(
  executableName: string,
  overrideVariable: string,
  resolveManaged: () => Promise<ResolvedExecutable | null>,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<readonly ResolvedExecutable[]> {
  const override = options.environment[overrideVariable];
  if (override !== undefined) {
    if (override.length === 0 || !isAbsolute(override)) {
      return [];
    }
    const executable = await resolveExecutablePath(override, options.platform);
    return executable === null ? [] : [executable];
  }
  const external = await findExecutableOnPath(
    executableName,
    options.environment,
    options.platform,
  );
  const managed = await resolveManaged();
  if (external === null) {
    return managed === null ? [] : [managed];
  }
  if (managed === null || managed.path === external.path) {
    return [external];
  }
  return [external, managed];
}

async function resolveAgentExecutables(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<readonly ResolvedExecutable[]> {
  return await resolveSpecificationExecutables(
    specification.agentExecutable,
    specification.agentOverrideVariable,
    async () => await resolveManagedExecutable(specification, options),
    options,
  );
}

async function resolveAdapterExecutables(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<readonly ResolvedExecutable[]> {
  return await resolveSpecificationExecutables(
    specification.adapterExecutable,
    specification.adapterOverrideVariable,
    async () => await resolveManagedAdapterExecutable(specification, options),
    options,
  );
}

export async function resolveAgentExecutable(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<ResolvedExecutable | null> {
  const executables = await resolveAgentExecutables(specification, options);
  return executables[0] ?? null;
}

export async function resolveAdapterExecutable(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<ResolvedExecutable | null> {
  const executables = await resolveAdapterExecutables(specification, options);
  return executables[0] ?? null;
}

function normalizedVersion(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 128) ?? "";
}

async function probeVersion(
  executable: ResolvedExecutable,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultWorkspace: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runBoundedProcess({
    arguments: arguments_,
    command: executable.path,
    cwd: defaultWorkspace,
    environment,
    signal,
    timeoutMilliseconds: VERSION_PROBE_TIMEOUT_MILLISECONDS,
  });
  const version = normalizedVersion(result.stdout || result.stderr);
  if (version.length === 0) {
    throw new ProcessExecutionError(
      "process_exit_failed",
      "The executable did not report a version",
    );
  }
  return version;
}

export class VerifiedAgentExecutable {
  readonly executable: ResolvedExecutable;
  readonly version: string;

  constructor(executable: ResolvedExecutable, version: string) {
    this.executable = executable;
    this.version = version;
  }
}

export async function findVerifiedAgentExecutable(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<VerifiedAgentExecutable | null> {
  const executables = await resolveAgentExecutables(specification, options);
  for (const executable of executables) {
    try {
      const version = await probeVersion(
        executable,
        specification.agentVersionArguments,
        options.environment,
        options.defaultWorkspace,
        options.signal,
      );
      return new VerifiedAgentExecutable(executable, version);
    } catch {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
    }
  }
  return null;
}

function readableAcpStream(
  input: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let byteLength = 0;
  let open = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: unknown) => {
        if (!open) {
          return;
        }
        if (!(chunk instanceof Uint8Array)) {
          open = false;
          controller.error(new Error("ACP adapter produced invalid output"));
          return;
        }
        byteLength += chunk.byteLength;
        if (byteLength > ACP_OUTPUT_LIMIT_BYTES) {
          open = false;
          controller.error(new Error("ACP adapter output limit exceeded"));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      input.once("end", () => {
        if (open) {
          open = false;
          controller.close();
        }
      });
      input.once("error", (error) => {
        if (open) {
          open = false;
          controller.error(error);
        }
      });
    },
    cancel() {
      open = false;
    },
  });
}

function writableAcpStream(
  output: NodeJS.WritableStream,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolveWrite, rejectWrite) => {
        output.write(chunk, (error) => {
          if (error) {
            rejectWrite(error);
            return;
          }
          resolveWrite();
        });
      });
    },
  });
}

async function probeAcp(
  specification: LocalAgentSpecification,
  agent: LocalAgentDefinition,
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultWorkspace: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("ACP probe timed out"));
  }, specification.acpProbeTimeoutMilliseconds);
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const child = spawn(agent.adapterPath, [...agent.arguments], {
    cwd: defaultWorkspace,
    detached: process.platform !== "win32",
    env: { ...environment, ...agent.environment },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processExit = new Promise<never>((_resolve, reject) => {
    const rejectExit = (): void =>
      reject(new Error("ACP adapter exited during initialization"));
    child.once("error", reject);
    child.once("exit", rejectExit);
    if (child.exitCode !== null || child.signalCode !== null) rejectExit();
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdin === null || stdout === null || stderr === null) {
    await stopProcessTree(child);
    throw new AgentProbeError(
      "acp_incompatible",
      "ACP adapter streams are unavailable",
    );
  }
  let stderrBytes = 0;
  const consumeStderr = (chunk: Buffer): void => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > ACP_OUTPUT_LIMIT_BYTES) {
      controller.abort(new Error("ACP adapter output limit exceeded"));
    }
  };
  stderr.on("data", consumeStderr);
  const connection = createAcpClient(new DiscoveryAcpHandler()).connect(
    ndJsonStream(writableAcpStream(stdin), readableAcpStream(stdout)),
  );

  try {
    const initialized = await Promise.race([
      connection.agent.request(
        methods.agent.initialize,
        {
          clientCapabilities: {},
          clientInfo: { name: "mobius", version: "0.0.3" },
          protocolVersion: PROTOCOL_VERSION,
        },
        { cancellationSignal: controller.signal },
      ),
      processExit,
    ]);
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new AgentProbeError(
        "acp_incompatible",
        "ACP adapter selected an unsupported protocol version",
      );
    }
    await specification.verifyAcp(
      connection,
      initialized,
      defaultWorkspace,
      controller.signal,
    );
    return normalizedVersion(initialized.agentInfo?.version ?? "");
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    if (timedOut) {
      throw new AgentProbeError(
        "adapter_probe_timeout",
        "ACP adapter probe timed out",
        { cause: error },
      );
    }
    if (error instanceof AgentProbeError) {
      throw error;
    }
    if (
      error instanceof RequestError &&
      error.code === -32_000 &&
      specification.authenticationCommand().length > 0
    ) {
      throw new AgentProbeError(
        "authentication_required",
        "Agent authentication is required",
        { cause: error },
      );
    }
    throw new AgentProbeError(
      "acp_incompatible",
      "ACP adapter initialization failed",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    connection.close();
    stdin.end();
    stderr.removeListener("data", consumeStderr);
    await stopProcessTree(child);
  }
}

function probeFailure(
  specification: LocalAgentSpecification,
  executableKind: string,
  error: unknown,
): UnavailableAgent {
  if (error instanceof AgentProbeError) {
    if (error.code === "authentication_required") {
      return new AuthenticationRequiredAgent(specification);
    }
    return error.code === "acp_incompatible"
      ? new IncompatibleAdapter(specification)
      : new ProbeFailed(specification, error.code, error.message);
  }
  if (error instanceof ProcessExecutionError) {
    const code =
      error.code === "process_timeout"
        ? `${executableKind}_probe_timeout`
        : `${executableKind}_probe_failed`;
    return new ProbeFailed(
      specification,
      code,
      `${executableKind === "agent" ? "Agent" : "Adapter"} version probe failed`,
    );
  }
  return new ProbeFailed(
    specification,
    `${executableKind}_probe_failed`,
    `${executableKind === "agent" ? "Agent" : "Adapter"} probe failed`,
  );
}

async function discoverSpecification(
  specification: LocalAgentSpecification,
  options: DiscoverLocalAgentInventoryOptions,
): Promise<AgentDiscovery> {
  options.signal.throwIfAborted();
  const [adapters, agents] = await Promise.all([
    resolveAdapterExecutables(specification, options),
    resolveAgentExecutables(specification, options),
  ]);
  if (adapters.length === 0) {
    return new MissingAdapter(specification);
  }
  if (agents.length === 0) {
    return new MissingAgent(specification);
  }

  let lastFailure: UnavailableAgent | null = null;
  for (const agent of agents) {
    let agentVersion = "";
    try {
      agentVersion = await probeVersion(
        agent,
        specification.agentVersionArguments,
        options.environment,
        options.defaultWorkspace,
        options.signal,
      );
    } catch (error) {
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      lastFailure = probeFailure(specification, "agent", error);
      continue;
    }

    for (const adapter of adapters) {
      let adapterVersion = "";
      try {
        if (specification.adapterVersionArguments.length > 0) {
          adapterVersion = await probeVersion(
            adapter,
            specification.adapterVersionArguments,
            {
              ...options.environment,
              [specification.adapterEnvironmentVariable]: agent.path,
            },
            options.defaultWorkspace,
            options.signal,
          );
        }
      } catch (error) {
        if (options.signal.aborted) {
          options.signal.throwIfAborted();
        }
        lastFailure = probeFailure(specification, "adapter", error);
        continue;
      }

      const definition = new LocalAgentDefinition(
        specification.id,
        specification.label,
        adapter.path,
        [],
        { [specification.adapterEnvironmentVariable]: agent.path },
        adapterVersion,
        agentVersion,
        adapter.identity,
        agent.identity,
        specification.promptTimeoutMilliseconds,
      );
      try {
        const acpVersion = await probeAcp(
          specification,
          definition,
          options.environment,
          options.defaultWorkspace,
          options.signal,
        );
        const verifiedAdapterVersion =
          adapterVersion.length > 0 ? adapterVersion : acpVersion;
        if (verifiedAdapterVersion.length === 0) {
          throw new AgentProbeError(
            "acp_incompatible",
            "ACP adapter did not report a version",
          );
        }
        return new AvailableAgent(
          specification,
          new LocalAgentDefinition(
            specification.id,
            specification.label,
            adapter.path,
            [],
            { [specification.adapterEnvironmentVariable]: agent.path },
            verifiedAdapterVersion,
            agentVersion,
            adapter.identity,
            agent.identity,
            specification.promptTimeoutMilliseconds,
          ),
        );
      } catch (error) {
        if (options.signal.aborted) {
          options.signal.throwIfAborted();
        }
        lastFailure = probeFailure(specification, "adapter", error);
      }
    }
  }
  return lastFailure ?? new IncompatibleAdapter(specification);
}

export async function discoverLocalAgentInventory(
  options: DiscoverLocalAgentInventoryOptions,
): Promise<LocalAgentInventory> {
  const specifications =
    options.specifications ?? supportedLocalAgentSpecifications();
  const discoveries = await Promise.all(
    specifications.map(
      async (specification) =>
        await discoverSpecification(specification, options),
    ),
  );
  let grantedAgents: ReadonlySet<string> = new Set<string>();
  try {
    grantedAgents = await readGrantedAgents(
      readStateDirectory(options.environment),
    );
  } catch {
    // An invalid local grant is ignored so it can never widen installation authority.
  }
  return new LocalAgentInventory(
    discoveries,
    grantedAgents,
    options.platform,
    options.architecture,
  );
}
