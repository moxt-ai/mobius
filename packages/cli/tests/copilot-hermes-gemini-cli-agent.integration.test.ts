import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import {
    AvailableAgent,
    CopilotCliAgentSpecification,
    discoverLocalAgentInventory,
    GeminiCliAgentSpecification,
    HermesAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("Copilot CLI, Hermes Agent, and Gemini CLI integrations", () => {
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

    it("Given Hermes Agent is installed in its official user-local directory outside PATH, When Mobius discovers and prompts it, Then Hermes runs through its native ACP entrypoint", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-hermes-agent-"));
        const executablePath = join(temporaryDirectory, ".local", "bin", "hermes");
        const manager = new AcpSessionManager();
        try {
            await mkdir(dirname(executablePath), { mode: 0o700, recursive: true });
            await writeFile(
                executablePath,
                executableSource(`
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["acp", "--version"])) {
  process.stdout.write("0.20.4\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["acp"])) process.exit(81);
  process.argv.push(
    "--agent-name", "Hermes Agent",
    "--agent-version", "0.20.4",
    "--external-authentication",
    "--no-additional-directories"
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
                    HOME: temporaryDirectory,
                    PATH: "",
                },
                signal: new AbortController().signal,
                specifications: [new HermesAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("Hermes Agent was not discovered");
            }
            const canonicalExecutable = await realpath(executablePath);
            expect(discovered.agent).toMatchObject({
                adapterPath: canonicalExecutable,
                adapterVersion: "0.20.4",
                agentVersion: "0.20.4",
                arguments: ["acp"],
                command: canonicalExecutable,
                environment: {},
                id: "hermes",
                label: "Hermes Agent",
            });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "hermes-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified Hermes executable",
                resources: [],
                sessionId: "hermes-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("Hermes Agent turn 1: use the verified Hermes executable");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a verified local Gemini CLI, When Mobius discovers and prompts it, Then the exact binary runs through its stable ACP entrypoint", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-gemini-cli-"));
        const executablePath = join(temporaryDirectory, "gemini");
        const manager = new AcpSessionManager();
        try {
            await writeFile(
                executablePath,
                executableSource(`
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["--version"])) {
  process.stdout.write("0.59.0\\n", () => process.exit(0));
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--acp"])) process.exit(81);
  process.argv.push(
    "--agent-name", "Gemini CLI",
    "--agent-version", "0.59.0",
    "--external-authentication",
    "--load-only",
    "--no-additional-directories",
    "--no-delete-session",
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
                environment: { PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [new GeminiCliAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("Gemini CLI was not discovered");
            }
            const canonicalExecutable = await realpath(executablePath);
            expect(discovered.agent).toMatchObject({
                adapterPath: canonicalExecutable,
                adapterVersion: "0.59.0",
                agentVersion: "0.59.0",
                arguments: ["--acp"],
                command: canonicalExecutable,
                environment: {},
                id: "gemini-cli",
                label: "Gemini CLI",
            });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "gemini-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified Gemini CLI executable",
                resources: [],
                sessionId: "gemini-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("Gemini CLI turn 1: use the verified Gemini CLI executable");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
