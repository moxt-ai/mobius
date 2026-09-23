import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class WorkBuddyFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<WorkBuddyFixture> {
        const executable = await resolveTestExecutable("codebuddy", "MOBIUS_TEST_WORKBUDDY_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-workbuddy-"));
        const configDirectory = join(directory, "codebuddy");
        const missing = join(directory, "missing-agent");
        await mkdir(configDirectory, { mode: 0o700 });
        await Promise.all([
            writeFile(
                join(configDirectory, "models.json"),
                JSON.stringify({
                    availableModels: [provider.model],
                    models: [
                        {
                            apiKey: FakeOpenAiProvider.apiKey,
                            id: provider.model,
                            maxInputTokens: 128_000,
                            maxOutputTokens: 8_192,
                            name: provider.model,
                            supportsToolCall: true,
                            url: `${provider.origin}/v1/chat/completions`,
                            vendor: "Custom",
                        },
                    ],
                }),
                { mode: 0o600 },
            ),
            writeFile(join(configDirectory, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }), {
                mode: 0o600,
            }),
        ]);
        return new WorkBuddyFixture(directory, executable, {
            CODEBUDDY_API_KEY: FakeOpenAiProvider.apiKey,
            CODEBUDDY_CONFIG_DIR: configDirectory,
            CODEBUDDY_MODEL: provider.model,
            DISABLE_AUTOUPDATER: "1",
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
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
            MOBIUS_WORKBUDDY_PATH: executable,
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
