import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { formatAgentDiagnostics } from "../src/agent-catalog/agent-diagnostics.ts";
import {
  AvailableAgent,
  CodexAgentSpecification,
  discoverLocalAgentInventory,
  PiAgentSpecification,
  resolveAgentExecutable,
} from "../src/agent-catalog/discover-local-agents.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

describe("local Agent discovery", () => {
  it("Given a verified Pi executable exists without pi-acp, When discovery runs, Then Pi is installable but not ready", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-pi-missing-adapter-"),
    );
    const piPath = join(temporaryDirectory, "pi");
    try {
      await writeFile(
        piPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
}
`),
        { mode: 0o700 },
      );
      await chmod(piPath, 0o700);

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: temporaryDirectory,
        environment: {
          MOBIUS_STATE_DIRECTORY: temporaryDirectory,
          PATH: temporaryDirectory,
        },
        signal: new AbortController().signal,
        specifications: [new PiAgentSpecification()],
      });

      expect(inventory.available).toEqual([]);
      expect(inventory.unavailable).toHaveLength(1);
      expect(inventory.unavailable[0]).toMatchObject({
        code: "adapter_not_found",
        status: "missing_adapter",
      });
      expect(inventory.installable).toEqual([
        expect.objectContaining({ id: "pi", label: "Pi" }),
      ]);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("Given Pi and pi-acp are verified but Pi needs local authentication, When discovery runs, Then Mobius reports authentication-required with only the terminal login entrypoint", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-pi-authentication-"),
    );
    const piPath = join(temporaryDirectory, "pi");
    const adapterPath = join(temporaryDirectory, "pi-acp");
    try {
      await writeFile(
        piPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  process.argv.push("--agent-name", "Pi", "--authentication-required");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await writeFile(
        adapterPath,
        executableSource(`
import { spawn } from "node:child_process";
const executable = process.env.PI_ACP_PI_COMMAND;
if (executable === undefined) process.exit(91);
const child = spawn(executable, ["--mode", "rpc"], {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(92));
child.once("exit", (code) => process.exit(code ?? 93));
`),
        { mode: 0o700 },
      );
      await Promise.all([chmod(piPath, 0o700), chmod(adapterPath, 0o700)]);

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: temporaryDirectory,
        environment: {
          MOBIUS_STATE_DIRECTORY: temporaryDirectory,
          PATH: temporaryDirectory,
        },
        signal: new AbortController().signal,
        specifications: [new PiAgentSpecification()],
      });

      expect(inventory.available).toEqual([]);
      expect(inventory.installable).toEqual([]);
      expect(inventory.unavailable).toHaveLength(1);
      expect(inventory.unavailable[0]).toMatchObject({
        code: "authentication_required",
        status: "authentication_required",
      });
      expect(JSON.parse(formatAgentDiagnostics(inventory, true))).toEqual({
        available: [],
        unavailable: [
          {
            code: "authentication_required",
            id: "pi",
            label: "Pi",
            message: "Agent authentication is required",
            recoveryCommand: "pi-acp --terminal-login",
            status: "authentication_required",
          },
        ],
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("Given PATH contains verified Pi and pi-acp executables, When local Agents are discovered, Then Pi is ready only through the exact executable and a bounded ACP prompt completes", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-pi-discovery-"),
    );
    const piPath = join(temporaryDirectory, "pi");
    const adapterPath = join(temporaryDirectory, "pi-acp");
    const manager = new AcpSessionManager();

    try {
      await writeFile(
        piPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) {
    process.exit(90);
  }
  process.argv.push("--agent-name", "Pi");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await writeFile(
        adapterPath,
        executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) process.exit(89);
const executable = process.env.PI_ACP_PI_COMMAND;
if (executable === undefined) process.exit(91);
const child = spawn(executable, ["--mode", "rpc"], {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(92));
child.once("exit", (code) => process.exit(code ?? 93));
`),
        { mode: 0o700 },
      );
      await Promise.all([chmod(piPath, 0o700), chmod(adapterPath, 0o700)]);

      const specification = new PiAgentSpecification();
      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: temporaryDirectory,
        environment: {
          MOBIUS_STATE_DIRECTORY: temporaryDirectory,
          PATH: temporaryDirectory,
        },
        signal: new AbortController().signal,
        specifications: [specification],
      });

      expect(inventory.unavailable).toEqual([]);
      expect(inventory.available).toHaveLength(1);
      const discovered = inventory.available[0];
      if (!(discovered instanceof AvailableAgent)) {
        throw new Error("Pi was not discovered");
      }
      expect(discovered.agent.id).toBe("pi");
      expect(discovered.agent.environment).toEqual({
        PI_ACP_PI_COMMAND: await realpath(piPath),
      });
      expect(discovered.agent.agentVersion).toBe("0.85.0");
      expect(discovered.agent.adapterVersion).toBe("1.0.0");

      const chunks: string[] = [];
      await manager.runPrompt({
        additionalDirectories: [],
        agent: discovered.agent,
        commandId: "pi-command",
        cwd: temporaryDirectory,
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          chunks.push(text);
          return Promise.resolve();
        },
        prompt: "use the verified Pi executable",
        resources: [],
        sessionId: "pi-session",
        signal: new AbortController().signal,
      });

      expect(chunks.join("")).toBe("Pi turn 1: use the verified Pi executable");
    } finally {
      await manager.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("Given PATH contains a runnable Codex CLI and adapter but no Claude integration, When local Agents are discovered, Then only Codex is ready and a prompt uses the resolved Codex executable", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-agent-discovery-"),
    );
    const codexPath = join(temporaryDirectory, "codex");
    const adapterPath = join(temporaryDirectory, "codex-acp");
    const manager = new AcpSessionManager();

    try {
      await writeFile(
        codexPath,
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
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env.CODEX_PATH;
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
        { mode: 0o700 },
      );
      await Promise.all([chmod(codexPath, 0o700), chmod(adapterPath, 0o700)]);

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: repositoryRoot,
        environment: {
          MOBIUS_STATE_DIRECTORY: temporaryDirectory,
          MOBIUS_WORKBUDDY_PATH: join(temporaryDirectory, "missing-workbuddy"),
          PATH: temporaryDirectory,
        },
        signal: new AbortController().signal,
      });

      expect(inventory.available).toHaveLength(1);
      const discovered = inventory.available[0];
      expect(discovered).toBeInstanceOf(AvailableAgent);
      if (!(discovered instanceof AvailableAgent)) {
        throw new Error("Codex was not discovered");
      }
      expect(discovered.agent.id).toBe("codex");
      expect(discovered.agent.environment).toEqual({
        CODEX_PATH: await realpath(codexPath),
      });
      expect(
        inventory.unavailable.map((agent) => agent.specification.id),
      ).toEqual([
        "claude",
        "pi",
        "deepseek-harness",
        "opencode",
        "cursor",
        "grok-build",
        "workbuddy",
      ]);

      const chunks: string[] = [];
      await manager.runPrompt({
        additionalDirectories: [],
        agent: discovered.agent,
        commandId: "discovered-command",
        cwd: temporaryDirectory,
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          chunks.push(text);
          return Promise.resolve();
        },
        prompt: "local executable",
        resources: [],
        sessionId: "discovered-session",
        signal: new AbortController().signal,
      });

      expect(chunks.join("")).toBe("Codex turn 1: local executable");
    } finally {
      await manager.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("Given PATH contains an incompatible adapter and the pinned private cache is valid, When a saved daemon discovers Agents again, Then it keeps the external Agent and falls back to the verified private adapter", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-agent-cache-fallback-"),
    );
    const externalDirectory = join(stateDirectory, "external");
    const agentPath = join(externalDirectory, "codex");
    const externalAdapterPath = join(externalDirectory, "codex-acp");
    const specification = new CodexAgentSpecification();
    const managedAdapterPath = join(
      stateDirectory,
      ...specification.managedAdapterExecutablePath,
    );
    const managedAdapterPackageRoot = dirname(dirname(managedAdapterPath));
    try {
      await Promise.all([
        mkdir(externalDirectory, { mode: 0o700, recursive: true }),
        mkdir(dirname(managedAdapterPath), {
          mode: 0o700,
          recursive: true,
        }),
      ]);
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
        externalAdapterPath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.7.0\\n");
} else {
  process.exit(7);
}
`),
        { mode: 0o700 },
      );
      await writeFile(
        managedAdapterPath,
        executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env.CODEX_PATH;
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
        { mode: 0o700 },
      );
      await writeFile(
        join(managedAdapterPackageRoot, "package.json"),
        JSON.stringify({
          bin: { "codex-acp": "dist/index.js" },
          name: specification.adapterPackage,
          version: specification.adapterVersion,
        }),
        { mode: 0o600 },
      );
      await Promise.all(
        [agentPath, externalAdapterPath, managedAdapterPath].map(
          async (path) => await chmod(path, 0o700),
        ),
      );

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: repositoryRoot,
        environment: {
          MOBIUS_STATE_DIRECTORY: stateDirectory,
          PATH: externalDirectory,
        },
        signal: new AbortController().signal,
        specifications: [specification],
      });

      expect(inventory.unavailable).toEqual([]);
      expect(inventory.available).toHaveLength(1);
      expect(inventory.available[0]?.agent.agentIdentity.realPath).toBe(
        await realpath(agentPath),
      );
      expect(inventory.available[0]?.agent.adapterIdentity.realPath).toBe(
        await realpath(managedAdapterPath),
      );
    } finally {
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "Given a discovered Agent symlink changes, When an existing conversation continues and a new one starts, Then the existing process remains usable and the new runtime is rejected",
    async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "mobius-agent-identity-"),
      );
      const firstAgentPath = join(temporaryDirectory, "codex-first");
      const secondAgentPath = join(temporaryDirectory, "codex-second");
      const codexLink = join(temporaryDirectory, "codex");
      const adapterPath = join(temporaryDirectory, "codex-acp");
      const manager = new AcpSessionManager();
      try {
        for (const path of [firstAgentPath, secondAgentPath]) {
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
        await symlink(firstAgentPath, codexLink);
        await writeFile(
          adapterPath,
          executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env.CODEX_PATH;
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("exit", (code) => process.exit(code ?? 92));
}
`),
          { mode: 0o700 },
        );
        await chmod(adapterPath, 0o700);
        const inventory = await discoverLocalAgentInventory({
          defaultWorkspace: repositoryRoot,
          environment: {
            MOBIUS_CODEX_ACP_PATH: adapterPath,
            MOBIUS_CODEX_PATH: codexLink,
            MOBIUS_WORKBUDDY_PATH: join(
              temporaryDirectory,
              "missing-workbuddy",
            ),
            PATH: temporaryDirectory,
          },
          signal: new AbortController().signal,
        });
        const discovered = inventory.available[0];
        if (!(discovered instanceof AvailableAgent)) {
          throw new Error("Codex was not discovered");
        }
        const run = async (
          sessionId: string,
          prompt: string,
        ): Promise<string> => {
          const chunks: string[] = [];
          await manager.runPrompt({
            additionalDirectories: [],
            agent: discovered.agent,
            commandId: `${sessionId}-${prompt}`,
            cwd: temporaryDirectory,
            images: [],
            onActivity: () => Promise.resolve(),
            onText: (text) => {
              chunks.push(text);
              return Promise.resolve();
            },
            prompt,
            resources: [],
            sessionId,
            signal: new AbortController().signal,
          });
          return chunks.join("");
        };

        await expect(run("existing-session", "before")).resolves.toBe(
          "Codex turn 1: before",
        );
        await unlink(codexLink);
        await symlink(secondAgentPath, codexLink);

        await expect(run("existing-session", "after")).resolves.toBe(
          "Codex turn 2: after",
        );
        await expect(run("new-session", "blocked")).rejects.toMatchObject({
          code: "agent_runtime_changed",
        });
      } finally {
        await manager.close();
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
  );

  it("Given PATH contains an Agent in the default working directory, When the paired machine discovers Agents, Then the working directory does not exclude that executable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mobius-path-boundary-"));
    const codexPath = join(workspace, "codex");
    try {
      await writeFile(
        codexPath,
        executableSource('process.stdout.write("codex 0.153.0\\n");'),
        { mode: 0o700 },
      );
      await chmod(codexPath, 0o700);
      const specification = new CodexAgentSpecification();

      await expect(
        resolveAgentExecutable(specification, {
          defaultWorkspace: workspace,
          environment: { PATH: workspace },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ path: await realpath(codexPath) });
      await expect(
        resolveAgentExecutable(specification, {
          defaultWorkspace: workspace,
          environment: {
            MOBIUS_CODEX_PATH: codexPath,
            PATH: workspace,
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ path: await realpath(codexPath) });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
