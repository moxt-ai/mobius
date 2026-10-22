import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test.runIf(process.platform === "darwin").each([
    { layout: "bundle", directories: ["2.1.299", "abcdef123456", "claude.app", "Contents", "MacOS"] },
    { layout: "legacy binary", directories: ["2.1.299"] },
])(
    "Given Claude Desktop has a $layout engine outside PATH, When the user lists Agents, Then Claude is ready",
    async ({ directories }) => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "DESKTOP_DISCOVERY_REPLY");
        await using claude = await ClaudeFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), "mobius-macos-desktop-"));
        const workspace = join(directory, "workspace");
        const home = join(directory, "home");
        const engineDirectory = join(home, "Library", "Application Support", "Claude", "claude-code", ...directories);
        try {
            await Promise.all([mkdir(workspace), mkdir(engineDirectory, { recursive: true })]);
            await symlink(claude.executable, join(engineDirectory, "claude"));
            const environment = Object.fromEntries(
                Object.entries({ ...process.env, ...claude.environment }).filter(
                    ([key]) => key !== "MOBIUS_CLAUDE_PATH" && key !== "PATH",
                ),
            );
            const result = await promisify(execFile)(
                process.execPath,
                [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), "agents", "--json"],
                {
                    cwd: workspace,
                    env: {
                        ...environment,
                        HOME: home,
                        PATH: dirname(process.execPath),
                        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
                    },
                    signal: AbortSignal.timeout(30_000),
                    timeout: 30_000,
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
