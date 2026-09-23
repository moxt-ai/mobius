import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class GrokFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<GrokFixture> {
        const executable = await resolveTestExecutable("grok", "MOBIUS_TEST_GROK_BUILD_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-grok-"));
        const grokHome = join(directory, "grok");
        const missing = join(directory, "missing-agent");
        const apiKey = `xai-${FakeOpenAiProvider.apiKey}`;
        await mkdir(grokHome, { mode: 0o700 });
        await writeFile(
            join(grokHome, "config.toml"),
            [
                "[models]",
                `default = ${JSON.stringify(provider.model)}`,
                "",
                `[model.${JSON.stringify(provider.model)}]`,
                `model = ${JSON.stringify(provider.model)}`,
                `base_url = ${JSON.stringify(`${provider.origin}/v1`)}`,
                `api_key = ${JSON.stringify(apiKey)}`,
                'api_backend = "responses"',
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        return new GrokFixture(directory, executable, {
            GROK_HOME: grokHome,
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_CODEX_ACP_PATH: missing,
            MOBIUS_COPILOT_PATH: missing,
            MOBIUS_CURSOR_PATH: missing,
            MOBIUS_DEEPSEEK_HARNESS_PATH: missing,
            MOBIUS_GEMINI_PATH: missing,
            MOBIUS_GROK_BUILD_PATH: executable,
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
