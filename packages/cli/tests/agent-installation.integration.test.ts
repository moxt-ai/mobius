import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_INSTALL_REQUEST_KIND,
  type AgentInstallRequestCommand,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import {
  CodexAgentSpecification,
  discoverLocalAgentInventory,
  PiAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import {
  InstallableAgentDefinition,
  LocalAgentCatalog,
} from "../src/agent-catalog/local-agent.ts";
import {
  type AgentInstallation,
  AgentInstallationManager,
  type InstallationAudit,
  type InstallationObserver,
  RunningInstallation,
  SucceededInstallation,
} from "../src/agent-installation/agent-installation-manager.ts";
import { AutomaticAdapterProvisioner } from "../src/agent-installation/automatic-adapter-provisioner.ts";
import {
  type AgentInstallRecipeOptions,
  FixedAgentInstallRecipe,
  fixedAgentInstallRecipes,
} from "../src/agent-installation/fixed-agent-install-recipes.ts";
import { FixedInstallationExecutor } from "../src/agent-installation/fixed-installation-executor.ts";
import { readGrantedAgents } from "../src/agent-installation/installation-grants.ts";
import { ConsoleInstallationAuthorizer } from "../src/agent-installation/local-installation-authorizer.ts";
import {
  type AdapterInstallationPort,
  ManagedAdapterInstaller,
} from "../src/agent-installation/managed-adapter-installer.ts";
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

// Real Agent and adapter installers depend on mutable package registries. These
// stateful boundary implementations create disposable executables so production
// discovery, identity validation, ACP verification, and filesystem publication
// still run without reaching a third-party installer.
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

async function writeInstallationGrant(
  stateDirectory: string,
  agentId = "codex",
): Promise<void> {
  await writeFile(
    join(stateDirectory, "installation-grants.json"),
    `${JSON.stringify({ agents: [agentId] })}\n`,
    { mode: 0o600 },
  );
}

function request(
  requestId: string,
  agentId = "codex",
): AgentInstallRequestCommand {
  return {
    agentId,
    kind: AGENT_INSTALL_REQUEST_KIND,
    requestId,
  };
}

describe("local Agent installation authorization", () => {
  it("Given Pi installation is selected, When its fixed recipe and adapter installer run, Then exact verified packages are installed without lifecycle scripts in separate private caches", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-pi-install-"));
    const executableDirectory = join(stateDirectory, "bin");
    const npmPath = join(executableDirectory, "npm");
    const piExecutable = executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) {
    process.exit(90);
  }
  process.argv.push("--agent-name", "Pi");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
    const adapterExecutable = executableSource(`
import { spawn } from "node:child_process";
const pi = process.env.PI_ACP_PI_COMMAND;
if (pi === undefined) process.exit(91);
const child = spawn(pi, ["--mode", "rpc"], {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(92));
child.once("exit", (code) => process.exit(code ?? 93));
`);
    try {
      await mkdir(executableDirectory, { mode: 0o700, recursive: true });
      await writeFile(
        npmPath,
        executableSource(`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const prefixIndex = process.argv.indexOf("--prefix");
const prefix = process.argv[prefixIndex + 1];
if (prefixIndex < 0 || prefix === undefined) process.exit(81);
const requested = process.argv.at(-1);
const installsAgent = requested === "@earendil-works/pi-coding-agent@0.85.0";
const installsAdapter = requested === "pi-acp@0.0.33";
if (!installsAgent && !installsAdapter) process.exit(82);
const packageName = installsAgent ? "@earendil-works/pi-coding-agent" : "pi-acp";
const version = installsAgent ? "0.85.0" : "0.0.33";
const executableName = installsAgent ? "pi" : "pi-acp";
const executablePath = installsAgent ? "dist/bundle/cli.js" : "dist/index.js";
const integrity = installsAgent
  ? "sha512-INxVkLAVfAMju5MojJpmyu/0bMP+r+ffZuS7UqVv32E2JwHBRbcHfELDfmFNvapEbgYfKN2r9OYO1p3TqDBR+g=="
  : "sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==";
const resolved = installsAgent
  ? "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.0.tgz"
  : "https://registry.npmjs.org/pi-acp/-/pi-acp-0.0.33.tgz";
const packageRoot = join(prefix, "node_modules", ...packageName.split("/"));
const executable = join(packageRoot, executablePath);
mkdirSync(join(executable, ".."), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
  name: packageName,
  version,
  bin: { [executableName]: executablePath },
}));
writeFileSync(
  executable,
  installsAgent
    ? ${JSON.stringify(piExecutable)}
    : ${JSON.stringify(adapterExecutable)},
  { mode: 0o700 },
);
chmodSync(executable, 0o700);
writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({
  lockfileVersion: 3,
  packages: {
    ["node_modules/" + packageName]: {
      integrity,
      resolved,
      version,
    },
  },
}));
writeFileSync(join(prefix, "npm-invocation.json"), JSON.stringify({
  arguments: process.argv.slice(2),
  ignoreScripts: process.env.NPM_CONFIG_IGNORE_SCRIPTS,
}));
`),
        { mode: 0o700 },
      );
      await chmod(npmPath, 0o700);
      const recipes = fixedAgentInstallRecipes().filter(
        (candidate) => candidate.id === "pi",
      );
      expect(recipes).toHaveLength(1);
      const recipe = recipes[0];
      if (recipe === undefined) {
        throw new Error("Pi installation recipe is unavailable");
      }
      await writeInstallationGrant(stateDirectory, "pi");
      const specification = new PiAgentSpecification();
      const observer = new RecordingInstallationObserver();
      const audit = new RecordingInstallationAudit();
      const catalog = new LocalAgentCatalog(
        [],
        [new InstallableAgentDefinition("pi", "Pi", false)],
      );
      const environment = {
        MOBIUS_STATE_DIRECTORY: stateDirectory,
        PATH: executableDirectory,
      };
      const manager = new AgentInstallationManager(
        [specification],
        new ConsoleInstallationAuthorizer(stateDirectory),
        new FixedInstallationExecutor(
          {
            defaultWorkspace: stateDirectory,
            audit,
            catalog,
            environment,
            publishCatalog: (signal) => {
              signal.throwIfAborted();
              return Promise.resolve();
            },
            stateDirectory,
          },
          [specification],
          [recipe],
          new ManagedAdapterInstaller({ environment, stateDirectory }),
        ),
        observer,
        audit,
      );

      await expect(
        manager.request(
          request("install-pi", "pi"),
          new AbortController().signal,
        ),
      ).resolves.toBeInstanceOf(SucceededInstallation);

      const packageRoot = join(stateDirectory, "agents", "pi", "0.85.0");
      expect(catalog.read().agents[0]?.agentIdentity.realPath).toBe(
        await realpath(
          join(
            packageRoot,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "bundle",
            "cli.js",
          ),
        ),
      );
      const invocation = await readFile(
        join(packageRoot, "npm-invocation.json"),
        "utf8",
      );
      expect(invocation).toContain("@earendil-works/pi-coding-agent@0.85.0");
      expect(invocation).toContain("--ignore-scripts");
      expect(invocation).toContain('"ignoreScripts":"true"');
      const adapterRoot = join(stateDirectory, "adapters", "pi", "0.0.33");
      expect(catalog.read().agents[0]?.adapterIdentity.realPath).toBe(
        await realpath(
          join(adapterRoot, "node_modules", "pi-acp", "dist", "index.js"),
        ),
      );
      await expect(
        readFile(join(adapterRoot, "npm-invocation.json"), "utf8"),
      ).resolves.toContain("pi-acp@0.0.33");
      expect(catalog.read().installableAgents).toEqual([]);
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
      await writeFile(
        join(packageRoot, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/@earendil-works/pi-coding-agent": {
              integrity: "sha512-tampered",
              resolved:
                "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.0.tgz",
              version: "0.85.0",
            },
          },
        }),
        { mode: 0o600 },
      );
      await expect(
        recipe.install({
          audit: new RecordingInstallationAudit(),
          environment,
          report: () => Promise.resolve(),
          requestId: "install-tampered-pi",
          signal: new AbortController().signal,
          stateDirectory,
        }),
      ).rejects.toMatchObject({ code: "agent_verification_failed" });
      await writeFile(
        join(adapterRoot, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/pi-acp": {
              integrity: "sha512-tampered",
              resolved: "https://registry.npmjs.org/pi-acp/-/pi-acp-0.0.33.tgz",
              version: "0.0.33",
            },
          },
        }),
        { mode: 0o600 },
      );
      await expect(
        new ManagedAdapterInstaller({
          environment,
          stateDirectory,
        }).install(new PiAgentSpecification(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "adapter_verification_failed" });
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
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
        await writeInstallationGrant(stateDirectory);

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
      await writeInstallationGrant(stateDirectory);
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
        new ConsoleInstallationAuthorizer(stateDirectory),
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
      await writeInstallationGrant(stateDirectory);
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
        new ConsoleInstallationAuthorizer(stateDirectory),
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
