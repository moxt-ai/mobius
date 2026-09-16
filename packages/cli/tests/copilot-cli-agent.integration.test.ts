import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import {
    AvailableAgent,
    CopilotCliAgentSpecification,
    discoverLocalAgentInventory,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("Copilot CLI Agent integration", () => {
    it("Given a verified local GitHub Copilot CLI, When Mobius discovers and prompts it, Then the exact binary runs through stdio ACP with automatic updates disabled", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-copilot-cli-"));
        const executablePath = join(temporaryDirectory, "copilot");
        const manager = new AcpSessionManager();
        try {
            await writeFile(
                executablePath,
                executableSource(`
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["--version"])) {
  process.stdout.write("GitHub Copilot CLI 1.0.83\\n", () => process.exit(0));
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--no-auto-update", "--acp", "--stdio"])) process.exit(81);
  if (process.env.COPILOT_AUTO_UPDATE !== "false") process.exit(82);
  process.argv.push(
    "--agent-name", "GitHub Copilot CLI",
    "--agent-version", "1.0.83",
    "--external-authentication",
    "--load-only",
    "--no-additional-directories",
    "--no-fork-session"
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(executablePath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    COPILOT_AUTO_UPDATE: "true",
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new CopilotCliAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("GitHub Copilot CLI was not discovered");
            }
            const canonicalExecutable = await realpath(executablePath);
            expect(discovered.agent).toMatchObject({
                adapterPath: canonicalExecutable,
                adapterVersion: "GitHub Copilot CLI 1.0.83",
                agentVersion: "GitHub Copilot CLI 1.0.83",
                arguments: ["--no-auto-update", "--acp", "--stdio"],
                command: canonicalExecutable,
                environment: { COPILOT_AUTO_UPDATE: "false" },
                id: "github-copilot-cli",
                label: "GitHub Copilot CLI",
            });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "copilot-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified GitHub Copilot executable",
                resources: [],
                sessionId: "copilot-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("GitHub Copilot CLI turn 1: use the verified GitHub Copilot executable");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
