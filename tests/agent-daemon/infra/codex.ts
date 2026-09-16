import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class CodexFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<CodexFixture> {
        const [executable, adapter] = await Promise.all([
            resolveTestExecutable("codex", "MOBIUS_TEST_CODEX_PATH"),
            resolveTestExecutable("codex-acp", "MOBIUS_TEST_CODEX_ACP_PATH"),
        ]);
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-codex-"));
        const codexHome = join(directory, "codex");
        const missing = join(directory, "missing-agent");
        await mkdir(codexHome, { recursive: true });
        await writeFile(
            join(codexHome, "config.toml"),
            [
                `model = ${JSON.stringify(provider.model)}`,
                `openai_base_url = ${JSON.stringify(`${provider.origin}/v1`)}`,
                'approval_policy = "never"',
                'sandbox_mode = "read-only"',
                'model_reasoning_effort = "low"',
                'model_reasoning_summary = "none"',
                "model_supports_reasoning_summaries = false",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        return new CodexFixture(directory, executable, {
            CODEX_API_KEY: FakeOpenAiProvider.apiKey,
            CODEX_HOME: codexHome,
            DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
            MOBIUS_CODEX_PATH: executable,
            MOBIUS_CODEX_ACP_PATH: adapter,
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
