import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_INSTALL_REQUEST_KIND,
  type AgentInstallationStage,
  type AgentInstallRequestCommand,
  MOBIUS_PROTOCOL_VERSION,
} from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAgentSpecification,
  discoverLocalAgentInventory,
} from "../src/agent-catalog/discover-local-agents.ts";
import {
  InstallableAgentDefinition,
  LocalAgentCatalog,
} from "../src/agent-catalog/local-agent.ts";
import {
  type AgentInstallation,
  AgentInstallationManager,
  AwaitingLocalApproval,
  CancelledInstallation,
  FailedInstallation,
  type InstallationAudit,
  type InstallationAuthorizer,
  type InstallationExecutor,
  type InstallationObserver,
  RunningInstallation,
  SucceededInstallation,
} from "../src/agent-installation/agent-installation-manager.ts";
import { AutomaticAdapterProvisioner } from "../src/agent-installation/automatic-adapter-provisioner.ts";
import {
  type AgentInstallRecipeOptions,
  FixedAgentInstallRecipe,
} from "../src/agent-installation/fixed-agent-install-recipes.ts";
import { FixedInstallationExecutor } from "../src/agent-installation/fixed-installation-executor.ts";
import { readGrantedAgents } from "../src/agent-installation/installation-grants.ts";
import { ConsoleInstallationAuthorizer } from "../src/agent-installation/local-installation-authorizer.ts";
import type { AdapterInstallationPort } from "../src/agent-installation/managed-adapter-installer.ts";
import {
  type ResolvedExecutable,
  resolveExecutablePath,
} from "../src/process/executable.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

class FixedAuthorizer implements InstallationAuthorizer {
  readonly approved: boolean;
  readonly requests: string[] = [];

  constructor(approved: boolean) {
    this.approved = approved;
  }

  readonly authorize = (
    agentId: string,
    _label: string,
    _requestId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    this.requests.push(agentId);
    return Promise.resolve(this.approved);
  };
}

class StatefulInstallationExecutor implements InstallationExecutor {
  readonly executions: string[] = [];
  readonly hold: boolean;
  readonly started = Promise.withResolvers<void>();

  constructor(hold = false) {
    this.hold = hold;
  }

  readonly execute = async (
    agentId: string,
    _requestId: string,
    report: (stage: AgentInstallationStage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> => {
    this.executions.push(agentId);
    await report("downloading");
    this.started.resolve();
    if (!this.hold || this.executions.length > 1) {
      await report("verifying");
      await report("checking_acp");
      return;
    }
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
  };
}

class RecordingInstallationObserver implements InstallationObserver {
  readonly states: AgentInstallation[] = [];

  readonly onState = (state: AgentInstallation): Promise<void> => {
    this.states.push(state);
    return Promise.resolve();
  };
}

class RecordingInstallationAudit implements InstallationAudit {
  readonly events: string[] = [];

  readonly record = (event: string): void => {
    this.events.push(event);
  };
}

class StatefulCodexInstallRecipe extends FixedAgentInstallRecipe {
  readonly id = "codex";
  readonly label = "Codex";
  readonly releaseChannel = "test-standalone";

  readonly install = async (
    options: AgentInstallRecipeOptions,
  ): Promise<ResolvedExecutable> => {
    await options.report("downloading");
    await options.report("verifying");
    await options.report("installing_agent");
    const directory = join(options.stateDirectory, "agents", "codex", "bin");
    const path = join(directory, "codex");
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(
      path,
      executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
      { mode: 0o700 },
    );
    await chmod(path, 0o700);
    const executable = await resolveExecutablePath(path);
    if (executable === null) {
      throw new Error("Stateful Codex recipe did not create an executable");
    }
    return executable;
  };
}

class StatefulAdapterInstaller implements AdapterInstallationPort {
  readonly #stateDirectory: string;
  readonly installedAgentIds: string[] = [];

  constructor(stateDirectory: string) {
    this.#stateDirectory = stateDirectory;
  }

  readonly install: AdapterInstallationPort["install"] = async (
    specification,
    signal,
  ) => {
    signal.throwIfAborted();
    this.installedAgentIds.push(specification.id);
    const directory = join(
      this.#stateDirectory,
      "adapters",
      specification.id,
      specification.adapterVersion,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
    );
    const path = join(directory, "index.js");
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(
      path,
      executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env[${JSON.stringify(
    specification.adapterEnvironmentVariable,
  )}];
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
      { mode: 0o700 },
    );
    await chmod(path, 0o700);
    const executable = await resolveExecutablePath(path);
    if (executable === null) {
      throw new Error(
        "Stateful adapter installer did not create an executable",
      );
    }
    return executable;
  };
}

class FailingAdapterInstaller implements AdapterInstallationPort {
  readonly installedAgentIds: string[] = [];

  readonly install: AdapterInstallationPort["install"] = (
    specification,
    signal,
  ) => {
    signal.throwIfAborted();
    this.installedAgentIds.push(specification.id);
    return Promise.reject(new Error("Deterministic adapter install failure"));
  };
}

class CancellingAdapterInstaller implements AdapterInstallationPort {
  readonly #controller: AbortController;
  readonly #reason: Error;

  constructor(controller: AbortController, reason: Error) {
    this.#controller = controller;
    this.#reason = reason;
  }

  readonly install: AdapterInstallationPort["install"] = (
    _specification,
    signal,
  ) => {
    signal.throwIfAborted();
    this.#controller.abort(this.#reason);
    return Promise.reject(signal.reason);
  };
}

async function writeExternalCodexAgent(path: string): Promise<void> {
  await mkdir(join(path, ".."), { mode: 0o700, recursive: true });
  await writeFile(
    path,
    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

function request(requestId: string): AgentInstallRequestCommand {
  return {
    agentId: "codex",
    kind: AGENT_INSTALL_REQUEST_KIND,
    protocolVersion: MOBIUS_PROTOCOL_VERSION,
    requestId,
  };
}

describe("local Agent installation authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Given no local installation grant, When Web requests Codex installation, Then no installer starts while local approval is denied", async () => {
    const authorizer = new FixedAuthorizer(false);
    const executor = new StatefulInstallationExecutor();
    const observer = new RecordingInstallationObserver();
    const manager = new AgentInstallationManager(
      [new CodexAgentSpecification()],
      authorizer,
      executor,
      observer,
    );

    const state = await manager.request(
      request("install-denied"),
      new AbortController().signal,
    );

    expect(authorizer.requests).toEqual(["codex"]);
    expect(executor.executions).toEqual([]);
    expect(
      observer.states.some(
        (candidate) => candidate instanceof AwaitingLocalApproval,
      ),
    ).toBe(true);
    expect(state).toMatchObject({ code: "installation_not_authorized" });
  });

  it.skipIf(process.stdin.isTTY || process.stdout.isTTY)(
    "Given no locally configured capability grant in a headless daemon, When authorization is requested, Then installation is denied without execution",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-install-authorization-"),
      );
      try {
        const authorizer = new ConsoleInstallationAuthorizer(stateDirectory);
        await expect(
          authorizer.authorize(
            "codex",
            "Codex",
            "install-headless",
            new AbortController().signal,
          ),
        ).resolves.toBe(false);
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );

  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      (process.arch === "arm64" || process.arch === "x64"),
  )(
    "Given a private narrow Codex grant, When local grants are resolved, Then it cannot authorize Claude Code or widen the recipe",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-install-grant-"),
      );
      try {
        await writeFile(
          join(stateDirectory, "installation-grants.json"),
          `${JSON.stringify({ agents: ["codex"], version: 1 })}\n`,
          { mode: 0o600 },
        );

        const grants = await readGrantedAgents(stateDirectory);

        expect([...grants]).toEqual(["codex"]);
        expect(grants.has("claude")).toBe(false);
        await expect(
          new ConsoleInstallationAuthorizer(stateDirectory).authorize(
            "codex",
            "Codex",
            "install-granted",
            new AbortController().signal,
          ),
        ).resolves.toBe(true);
        const inventory = await discoverLocalAgentInventory({
          defaultWorkspace: stateDirectory,
          environment: {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: "",
          },
          signal: new AbortController().signal,
        });
        expect(
          inventory.installable.find((agent) => agent.id === "codex"),
        ).toMatchObject({ requiresLocalApproval: false });
        expect(
          inventory.installable.find((agent) => agent.id === "claude"),
        ).toMatchObject({ requiresLocalApproval: true });
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );

  it("Given local approval for a fixed recipe, When the same request is delivered twice, Then installation runs once and returns the same completed state", async () => {
    const executor = new StatefulInstallationExecutor();
    const observer = new RecordingInstallationObserver();
    const manager = new AgentInstallationManager(
      [new CodexAgentSpecification()],
      new FixedAuthorizer(true),
      executor,
      observer,
    );
    const command = request("install-once");

    const first = await manager.request(command, new AbortController().signal);
    const second = await manager.request(command, new AbortController().signal);

    expect(first).toBeInstanceOf(SucceededInstallation);
    expect(second).toBe(first);
    expect(executor.executions).toEqual(["codex"]);
    expect(
      observer.states
        .filter((state) => state instanceof RunningInstallation)
        .map((state) => state.stage),
    ).toEqual(["downloading", "verifying", "checking_acp"]);
  });

  it("Given the local user approves Codex installation, When the fixed execution path completes, Then the Agent and adapter pass ACP verification before the catalog is published", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-fixed-installation-"),
    );
    const specification = new CodexAgentSpecification();
    const recipe = new StatefulCodexInstallRecipe();
    const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
    const observer = new RecordingInstallationObserver();
    const audit = new RecordingInstallationAudit();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    let publications = 0;
    try {
      const executor = new FixedInstallationExecutor(
        {
          defaultWorkspace: stateDirectory,
          audit,
          catalog,
          environment: { MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: "" },
          publishCatalog: (signal) => {
            signal.throwIfAborted();
            publications += 1;
            return Promise.resolve();
          },
          stateDirectory,
        },
        [specification],
        [recipe],
        adapterInstaller,
      );
      const manager = new AgentInstallationManager(
        [specification],
        new FixedAuthorizer(true),
        executor,
        observer,
        audit,
      );

      await expect(
        manager.request(
          request("fixed-installation"),
          new AbortController().signal,
        ),
      ).resolves.toBeInstanceOf(SucceededInstallation);

      expect(publications).toBe(1);
      expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["codex"]);
      expect(catalog.read().installableAgents).toEqual([]);
      const ready = catalog.read().agents[0];
      expect(ready?.agentIdentity.realPath).toBe(
        await realpath(join(stateDirectory, "agents", "codex", "bin", "codex")),
      );
      expect(ready?.adapterIdentity.realPath).toBe(
        await realpath(
          join(
            stateDirectory,
            "adapters",
            "codex",
            specification.adapterVersion,
            "node_modules",
            "@agentclientprotocol",
            "codex-acp",
            "dist",
            "index.js",
          ),
        ),
      );
      expect(audit.events).toContain("agent_installation_acp_verified");
      expect(
        observer.states
          .filter((state) => state instanceof RunningInstallation)
          .map((state) => state.stage),
      ).toEqual([
        "downloading",
        "verifying",
        "installing_agent",
        "installing_adapter",
        "checking_acp",
      ]);
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given an external adapter is present but ACP-incompatible, When installation is approved, Then Mobius keeps the verified Agent and falls back to its pinned private adapter", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-adapter-fallback-"),
    );
    const executableDirectory = join(stateDirectory, "external");
    const agentPath = join(executableDirectory, "codex");
    const adapterPath = join(executableDirectory, "codex-acp");
    const specification = new CodexAgentSpecification();
    const recipe = new StatefulCodexInstallRecipe();
    const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
    const observer = new RecordingInstallationObserver();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    try {
      await mkdir(executableDirectory, { mode: 0o700, recursive: true });
      await writeFile(
        agentPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await writeFile(
        adapterPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.7.0\\n");
} else {
  process.exit(7);
}
`),
        { mode: 0o700 },
      );
      await Promise.all([chmod(agentPath, 0o700), chmod(adapterPath, 0o700)]);
      const executor = new FixedInstallationExecutor(
        {
          defaultWorkspace: repositoryRoot,
          audit: new RecordingInstallationAudit(),
          catalog,
          environment: {
            MOBIUS_CODEX_ACP_PATH: adapterPath,
            MOBIUS_CODEX_PATH: agentPath,
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: "",
          },
          publishCatalog: (signal) => {
            signal.throwIfAborted();
            return Promise.resolve();
          },
          stateDirectory,
        },
        [specification],
        [recipe],
        adapterInstaller,
      );
      const manager = new AgentInstallationManager(
        [specification],
        new FixedAuthorizer(true),
        executor,
        observer,
      );

      await expect(
        manager.request(
          request("replace-incompatible-adapter"),
          new AbortController().signal,
        ),
      ).resolves.toBeInstanceOf(SucceededInstallation);

      expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["codex"]);
      const ready = catalog.read().agents[0];
      expect(ready?.agentIdentity.realPath).toBe(await realpath(agentPath));
      expect(ready?.adapterIdentity.realPath).toBe(
        await realpath(
          join(
            stateDirectory,
            "adapters",
            "codex",
            specification.adapterVersion,
            "node_modules",
            "@agentclientprotocol",
            "codex-acp",
            "dist",
            "index.js",
          ),
        ),
      );
      expect(
        observer.states
          .filter((state) => state instanceof RunningInstallation)
          .map((state) => state.stage),
      ).toEqual(["checking_acp", "installing_adapter", "checking_acp"]);
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given an approved installation is running, When Web cancels it, Then its process boundary observes cancellation and the slot is released", async () => {
    const executor = new StatefulInstallationExecutor(true);
    const manager = new AgentInstallationManager(
      [new CodexAgentSpecification()],
      new FixedAuthorizer(true),
      executor,
      new RecordingInstallationObserver(),
    );
    const running = manager.request(
      request("install-cancelled"),
      new AbortController().signal,
    );
    await executor.started.promise;

    await manager.cancel("install-cancelled");

    await expect(running).resolves.toBeInstanceOf(CancelledInstallation);
    await expect(
      manager.request(
        request("install-after-cancel"),
        new AbortController().signal,
      ),
    ).resolves.toBeInstanceOf(SucceededInstallation);
    expect(executor.executions).toEqual(["codex", "codex"]);
  });

  it("Given an approved installation is running, When the local daemon shuts down, Then Mobius waits for cancellation and releases the installation owner", async () => {
    const executor = new StatefulInstallationExecutor(true);
    const manager = new AgentInstallationManager(
      [new CodexAgentSpecification()],
      new FixedAuthorizer(true),
      executor,
      new RecordingInstallationObserver(),
    );
    const running = manager.request(
      request("install-daemon-shutdown"),
      new AbortController().signal,
    );
    await executor.started.promise;

    await manager.close();

    await expect(running).resolves.toBeInstanceOf(CancelledInstallation);
  });

  it("Given an approved installation exceeds its overall deadline, When the deadline expires, Then it fails distinctly and releases the per-Agent slot", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-04T00:00:00.000Z") });
    const executor = new StatefulInstallationExecutor(true);
    const manager = new AgentInstallationManager(
      [new CodexAgentSpecification()],
      new FixedAuthorizer(true),
      executor,
      new RecordingInstallationObserver(),
    );
    const running = manager.request(
      request("install-timeout"),
      new AbortController().signal,
    );
    await executor.started.promise;

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

    await expect(running).resolves.toEqual(
      expect.objectContaining({
        code: "installation_timeout",
      }),
    );
    await expect(
      manager.request(
        request("install-after-timeout"),
        new AbortController().signal,
      ),
    ).resolves.toBeInstanceOf(SucceededInstallation);
    expect(executor.executions).toEqual(["codex", "codex"]);
    expect(
      await manager.request(
        request("install-timeout"),
        new AbortController().signal,
      ),
    ).toBeInstanceOf(FailedInstallation);
  });
});

describe("automatic ACP adapter provisioning", () => {
  it("Given a verified local Codex CLI without an adapter, When the daemon prepares its catalog, Then it installs only the pinned adapter and exposes Codex as ready", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-automatic-adapter-"),
    );
    const agentPath = join(stateDirectory, "external", "codex");
    const specification = new CodexAgentSpecification();
    const audit = new RecordingInstallationAudit();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
    try {
      await writeExternalCodexAgent(agentPath);
      const inventory = await new AutomaticAdapterProvisioner(
        {
          defaultWorkspace: repositoryRoot,
          audit,
          catalog,
          environment: {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: join(stateDirectory, "external"),
          },
        },
        adapterInstaller,
        [specification],
      ).prepare(new AbortController().signal);

      expect(adapterInstaller.installedAgentIds).toEqual(["codex"]);
      expect(inventory.readyAgents().map((agent) => agent.id)).toEqual([
        "codex",
      ]);
      expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["codex"]);
      expect(catalog.read().installableAgents).toEqual([]);
      expect(catalog.read().agents[0]?.agentIdentity.realPath).toBe(
        await realpath(agentPath),
      );
      expect(audit.events).toEqual([
        "agent_adapter_auto_install_started",
        "agent_adapter_auto_install_completed",
        "agent_adapter_auto_install_verified",
      ]);
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given no usable local Agent CLI, When the daemon prepares its catalog, Then it does not install an ACP adapter", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-automatic-adapter-no-agent-"),
    );
    const specification = new CodexAgentSpecification();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
    try {
      const inventory = await new AutomaticAdapterProvisioner(
        {
          defaultWorkspace: repositoryRoot,
          audit: new RecordingInstallationAudit(),
          catalog,
          environment: {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: "",
          },
        },
        adapterInstaller,
        [specification],
      ).prepare(new AbortController().signal);

      expect(adapterInstaller.installedAgentIds).toEqual([]);
      expect(inventory.readyAgents()).toEqual([]);
      expect(catalog.read().installableAgents.map((agent) => agent.id)).toEqual(
        ["codex"],
      );
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given the user explicitly configured an adapter path, When it is unavailable, Then automatic provisioning does not replace that override", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-automatic-adapter-override-"),
    );
    const agentPath = join(stateDirectory, "external", "codex");
    const specification = new CodexAgentSpecification();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
    try {
      await writeExternalCodexAgent(agentPath);
      const inventory = await new AutomaticAdapterProvisioner(
        {
          defaultWorkspace: repositoryRoot,
          audit: new RecordingInstallationAudit(),
          catalog,
          environment: {
            MOBIUS_CODEX_ACP_PATH: join(
              stateDirectory,
              "explicit-missing-adapter",
            ),
            MOBIUS_CODEX_PATH: agentPath,
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: "",
          },
        },
        adapterInstaller,
        [specification],
      ).prepare(new AbortController().signal);

      expect(adapterInstaller.installedAgentIds).toEqual([]);
      expect(inventory.readyAgents()).toEqual([]);
      expect(catalog.read().installableAgents.map((agent) => agent.id)).toEqual(
        ["codex"],
      );
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given a verified local Agent but adapter installation fails, When the daemon prepares its catalog, Then it stays usable and leaves the Agent installable", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-automatic-adapter-failure-"),
    );
    const agentPath = join(stateDirectory, "external", "codex");
    const specification = new CodexAgentSpecification();
    const audit = new RecordingInstallationAudit();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("codex", "Codex")],
    );
    const adapterInstaller = new FailingAdapterInstaller();
    try {
      await writeExternalCodexAgent(agentPath);
      const inventory = await new AutomaticAdapterProvisioner(
        {
          defaultWorkspace: repositoryRoot,
          audit,
          catalog,
          environment: {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: join(stateDirectory, "external"),
          },
        },
        adapterInstaller,
        [specification],
      ).prepare(new AbortController().signal);

      expect(adapterInstaller.installedAgentIds).toEqual(["codex"]);
      expect(inventory.readyAgents()).toEqual([]);
      expect(catalog.read().installableAgents.map((agent) => agent.id)).toEqual(
        ["codex"],
      );
      expect(audit.events).toEqual([
        "agent_adapter_auto_install_started",
        "agent_adapter_auto_install_failed",
      ]);
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given adapter provisioning is cancelled, When the installer returns, Then cancellation remains distinct and no catalog transition is committed", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-automatic-adapter-cancel-"),
    );
    const agentPath = join(stateDirectory, "external", "codex");
    const specification = new CodexAgentSpecification();
    const audit = new RecordingInstallationAudit();
    const catalog = new LocalAgentCatalog(
      [],
      [new InstallableAgentDefinition("sentinel", "Sentinel")],
    );
    const controller = new AbortController();
    const reason = new Error("Automatic adapter provisioning cancelled");
    try {
      await writeExternalCodexAgent(agentPath);
      const provisioning = new AutomaticAdapterProvisioner(
        {
          defaultWorkspace: repositoryRoot,
          audit,
          catalog,
          environment: {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: join(stateDirectory, "external"),
          },
        },
        new CancellingAdapterInstaller(controller, reason),
        [specification],
      ).prepare(controller.signal);

      await expect(provisioning).rejects.toBe(reason);
      expect(catalog.read().installableAgents.map((agent) => agent.id)).toEqual(
        ["sentinel"],
      );
      expect(audit.events).toEqual([
        "agent_adapter_auto_install_started",
        "agent_adapter_auto_install_cancelled",
      ]);
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });
});
