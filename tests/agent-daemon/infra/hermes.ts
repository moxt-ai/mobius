import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class HermesFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<HermesFixture> {
        const executable = await resolveTestExecutable("hermes", "MOBIUS_TEST_HERMES_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-hermes-"));
        const hermesHome = join(directory, "hermes");
        const missing = join(directory, "missing-agent");
        await mkdir(hermesHome, { mode: 0o700, recursive: true });
        await writeFile(
            join(hermesHome, "config.yaml"),
            [
                "model:",
                "  provider: custom",
                `  default: ${provider.model}`,
                `  base_url: ${provider.origin}/v1`,
                `  api_key: ${FakeOpenAiProvider.apiKey}`,
                "  streaming: true",
                "agent:",
                "  max_turns: 4",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        return new HermesFixture(directory, executable, {
            HERMES_HOME: hermesHome,
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
            MOBIUS_HERMES_PATH: executable,
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
