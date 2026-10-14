import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test.runIf(process.platform === "win32")(
    "Given real Claude is installed in the Windows native location outside PATH, When the user lists Agents, Then Claude is ready",
    async () => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "WINDOWS_DISCOVERY_REPLY");
        await using claude = await ClaudeFixture.create(provider, { requireAdapter: false });
        const directory = await mkdtemp(join(tmpdir(), "mobius-windows-claude-"));
        const workspace = join(directory, "workspace");
        const userProfile = join(directory, "user");
        const nativeDirectory = join(userProfile, ".local", "bin");
        const nativeExecutable = join(nativeDirectory, "claude.exe");
        try {
            await Promise.all([mkdir(workspace), mkdir(nativeDirectory, { recursive: true })]);
            await copyFile(claude.executable, nativeExecutable);
            const environment = Object.fromEntries(
                Object.entries({ ...process.env, ...claude.environment }).filter(
                    ([key]) => key !== "MOBIUS_CLAUDE_PATH" && key.toUpperCase() !== "PATH",
                ),
            );
            const result = await promisify(execFile)(
                process.execPath,
                [resolve(import.meta.dirname, "../../src/cli.ts"), "agents", "--json"],
                {
                    cwd: workspace,
                    env: {
                        ...environment,
                        Path: dirname(process.execPath),
                        USERPROFILE: userProfile,
                        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
                    },
                    signal: AbortSignal.timeout(30000),
                    timeout: 30000,
                    windowsHide: true,
                    maxBuffer: 1024 * 1024,
                },
            );
            const inventory: unknown = JSON.parse(result.stdout);
            expect(inventory).toMatchObject({
                available: expect.arrayContaining([expect.objectContaining({ id: "claude" })]),
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
