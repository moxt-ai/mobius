import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAnthropicProvider } from "../llm/anthropic.ts";
import { resolveTestExecutable } from "./executable.ts";

export class ClaudeFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(
        provider: FakeAnthropicProvider,
        options: { readonly requireAdapter?: boolean } = {},
    ): Promise<ClaudeFixture> {
        const executable = await resolveTestExecutable("claude", "MOBIUS_TEST_CLAUDE_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-claude-"));
        const missing = join(directory, "missing-agent");
        const adapter =
            options.requireAdapter === false
                ? missing
                : await resolveTestExecutable("claude-agent-acp", "MOBIUS_TEST_CLAUDE_ACP_PATH");
        return new ClaudeFixture(directory, executable, {
            ANTHROPIC_API_KEY: FakeAnthropicProvider.apiKey,
            ANTHROPIC_BASE_URL: provider.origin,
            ANTHROPIC_MODEL: provider.model,
            CLAUDE_CONFIG_DIR: join(directory, "claude"),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            HOME: directory,
            MOBIUS_CLAUDE_PATH: executable,
            MOBIUS_CLAUDE_ACP_PATH: adapter,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_CODEX_ACP_PATH: missing,
            MOBIUS_COPILOT_PATH: missing,
            MOBIUS_CURSOR_PATH: missing,
            MOBIUS_DEEPSEEK_HARNESS_PATH: missing,
            MOBIUS_GEMINI_PATH: missing,
            MOBIUS_GROK_BUILD_PATH: missing,
            MOBIUS_HERMES_PATH: missing,
            MOBIUS_OPENCODE_PATH: missing,
            MOBIUS_PI_PATH: missing,
            MOBIUS_PI_ACP_PATH: missing,
            MOBIUS_WORKBUDDY_PATH: missing,
            NO_BROWSER: "1",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, recursive: true });
    }
}
