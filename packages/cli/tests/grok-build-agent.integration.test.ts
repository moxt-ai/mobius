import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import {
    AvailableAgent,
    discoverLocalAgentInventory,
    GrokBuildAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("Grok Build Agent integration", () => {
    it("Given a verified local Grok Build, When Mobius discovers and prompts it, Then the exact binary runs through the update-disabled native ACP server", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-grok-build-"));
        const executablePath = join(temporaryDirectory, "grok");
        const manager = new AcpSessionManager();
        try {
            await writeFile(
                executablePath,
                executableSource(`
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["version"])) {
  process.stdout.write("grok 1.0.21 (test)\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--no-auto-update", "agent", "stdio"])) process.exit(81);
  process.argv.push("--agent-name", "Grok Build", "--agent-version", "1.0.21");
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
                specifications: [new GrokBuildAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("Grok Build was not discovered");
            }
            const canonicalExecutable = await realpath(executablePath);
            expect(discovered.agent).toMatchObject({
                adapterPath: canonicalExecutable,
                adapterVersion: "grok 1.0.21 (test)",
                agentVersion: "grok 1.0.21 (test)",
                arguments: ["--no-auto-update", "agent", "stdio"],
                command: canonicalExecutable,
                environment: {},
                id: "grok-build",
                label: "Grok Build",
            });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "grok-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified Grok Build executable",
                resources: [],
                sessionId: "grok-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("Grok Build turn 1: use the verified Grok Build executable");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
