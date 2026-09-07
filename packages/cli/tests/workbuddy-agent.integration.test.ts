import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { formatAgentDiagnostics } from "../src/agent-catalog/agent-diagnostics.ts";
import {
  AvailableAgent,
  discoverLocalAgentInventory,
  WorkBuddyAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

describe("WorkBuddy Agent integration", () => {
  it("Given a verified WorkBuddy runtime needs local authentication, When Mobius probes ACP, Then it reports only the local CodeBuddy sign-in entrypoint", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-workbuddy-authentication-"),
    );
    const executablePath = join(temporaryDirectory, "codebuddy");
    try {
      await writeFile(
        executablePath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("2.146.0\\n");
} else {
  process.argv.push("--agent-name", "WorkBuddy", "--agent-version", "2.146.0", "--authentication-required");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await chmod(executablePath, 0o700);

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: temporaryDirectory,
        environment: { PATH: temporaryDirectory },
        signal: new AbortController().signal,
        specifications: [new WorkBuddyAgentSpecification()],
      });

      expect(inventory.available).toEqual([]);
      expect(inventory.installable).toEqual([]);
      expect(JSON.parse(formatAgentDiagnostics(inventory, true))).toEqual({
        available: [],
        unavailable: [
          {
            code: "authentication_required",
            id: "workbuddy",
            label: "WorkBuddy",
            message: "Agent authentication is required",
            recoveryCommand: "codebuddy",
            status: "authentication_required",
          },
        ],
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("Given a verified local CodeBuddy Code runtime, When Mobius discovers and prompts WorkBuddy, Then the exact binary runs through ACP with updates disabled", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-workbuddy-"),
    );
    const executablePath = join(temporaryDirectory, "codebuddy");
    const manager = new AcpSessionManager();
    try {
      await writeFile(
        executablePath,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("2.146.0\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--acp"])) process.exit(81);
  if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(82);
  process.argv.push("--agent-name", "WorkBuddy", "--agent-version", "2.146.0");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
      );
      await chmod(executablePath, 0o700);

      const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: temporaryDirectory,
        environment: { DISABLE_AUTOUPDATER: "0", PATH: temporaryDirectory },
        signal: new AbortController().signal,
        specifications: [new WorkBuddyAgentSpecification()],
      });

      expect(inventory.unavailable).toEqual([]);
      expect(inventory.available).toHaveLength(1);
      const discovered = inventory.available[0];
      if (!(discovered instanceof AvailableAgent)) {
        throw new Error("WorkBuddy was not discovered");
      }
      const canonicalExecutable = await realpath(executablePath);
      expect(discovered.agent).toMatchObject({
        adapterPath: canonicalExecutable,
        adapterVersion: "2.146.0",
        agentVersion: "2.146.0",
        arguments: ["--acp"],
        command: canonicalExecutable,
        environment: { DISABLE_AUTOUPDATER: "1" },
        id: "workbuddy",
        label: "WorkBuddy",
      });

      const chunks: string[] = [];
      await manager.runPrompt({
        additionalDirectories: [],
        agent: discovered.agent,
        commandId: "workbuddy-command",
        cwd: temporaryDirectory,
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          chunks.push(text);
          return Promise.resolve();
        },
        prompt: "use the verified WorkBuddy executable",
        resources: [],
        sessionId: "workbuddy-session",
        signal: new AbortController().signal,
      });
      expect(chunks.join("")).toBe(
        "WorkBuddy turn 1: use the verified WorkBuddy executable",
      );
    } finally {
      await manager.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
