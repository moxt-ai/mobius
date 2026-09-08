import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import {
    AvailableAgent,
    CursorCliAgentSpecification,
    discoverLocalAgentInventory,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("Cursor CLI Agent integration", () => {
    it("Given a verified local Cursor CLI, When Mobius discovers and prompts it, Then the exact binary runs with updates disabled and Cursor extensions cannot break the ACP turn", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-cursor-cli-"));
        const executablePath = join(temporaryDirectory, "cursor-agent");
        const manager = new AcpSessionManager();
        try {
            await writeFile(
                executablePath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("2026.09.02-c22c1a3\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--disable-auto-update", "acp"])) process.exit(81);
  process.argv.push("--agent-name", "Cursor CLI", "--agent-version", "2026.09.02-c22c1a3");
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
                specifications: [new CursorCliAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("Cursor CLI was not discovered");
            }
            const canonicalExecutable = await realpath(executablePath);
            expect(discovered.agent).toMatchObject({
                adapterPath: canonicalExecutable,
                adapterVersion: "2026.09.02-c22c1a3",
                agentVersion: "2026.09.02-c22c1a3",
                arguments: ["--disable-auto-update", "acp"],
                command: canonicalExecutable,
                environment: {},
                id: "cursor",
                label: "Cursor CLI",
            });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "cursor-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "exercise Cursor extensions",
                resources: [],
                sessionId: "cursor-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("Cursor CLI turn 1: exercise Cursor extensions");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
