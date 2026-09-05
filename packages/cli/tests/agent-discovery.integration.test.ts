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
import {
  AvailableAgent,
  CodexAgentSpecification,
  discoverLocalAgentInventory,
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
        approvedRoot: repositoryRoot,
        environment: { PATH: temporaryDirectory },
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
      ).toEqual(["claude"]);

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
        approvedRoot: repositoryRoot,
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
      const firstAgentPath = join(temporaryDirectory, "codex-v1");
      const secondAgentPath = join(temporaryDirectory, "codex-v2");
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
          approvedRoot: repositoryRoot,
          environment: {
            MOBIUS_CODEX_ACP_PATH: adapterPath,
            MOBIUS_CODEX_PATH: codexLink,
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

  it("Given PATH points at an executable inside the approved workspace, When automatic lookup runs, Then it is rejected while an explicit local override remains authoritative", async () => {
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
          approvedRoot: workspace,
          environment: { PATH: workspace },
          signal: new AbortController().signal,
        }),
      ).resolves.toBeNull();
      await expect(
        resolveAgentExecutable(specification, {
          approvedRoot: workspace,
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
