import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

describe("Mobius CLI", () => {
  it("Given no running daemon, When help is requested, Then the CLI lists its daemon capabilities and exits", async () => {
    const result = await executeFile(process.execPath, [cliPath, "--help"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Mobius CLI");
    expect(result.stdout).toContain("mobius pair");
    expect(result.stdout).toContain("mobius start");
    expect(result.stdout).toContain("local daemon");
  });

  it("Given one local Agent integration is runnable, When JSON diagnostics are requested, Then ready and unavailable Agents are reported without local paths", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-agents-cli-"),
    );
    const codexPath = join(temporaryDirectory, "codex");
    const adapterPath = join(temporaryDirectory, "codex-acp");
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
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await Promise.all([chmod(codexPath, 0o700), chmod(adapterPath, 0o700)]);

      const result = await executeFile(
        process.execPath,
        [cliPath, "agents", "--json"],
        {
          env: {
            ...process.env,
            MOBIUS_DEFAULT_WORKSPACE: repositoryRoot,
            MOBIUS_CODEX_ACP_PATH: adapterPath,
            MOBIUS_CODEX_PATH: codexPath,
            MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "state"),
            PATH: temporaryDirectory,
          },
        },
      );
      const diagnostics: unknown = JSON.parse(result.stdout);

      expect(diagnostics).toEqual({
        available: [
          {
            adapterVersion: "codex-acp 1.8.0",
            agentVersion: "codex 0.153.0",
            id: "codex",
            label: "Codex",
            status: "ready",
          },
        ],
        unavailable: [
          {
            code: "adapter_not_found",
            id: "claude",
            label: "Claude Code",
            message: "ACP adapter not found",
            recoveryCommand:
              "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.73.0",
            status: "missing_adapter",
          },
        ],
      });
      expect(result.stdout).not.toContain(temporaryDirectory);
      expect(result.stderr).toBe("");
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
