import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class CopilotFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<CopilotFixture> {
        const executable = await resolveTestExecutable("copilot", "MOBIUS_TEST_COPILOT_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-copilot-"));
        const missing = join(directory, "missing-agent");
        return new CopilotFixture(directory, executable, {
            COPILOT_GITHUB_TOKEN: "",
            COPILOT_HOME: join(directory, "copilot"),
            COPILOT_MODEL: provider.model,
            COPILOT_OFFLINE: "true",
            COPILOT_PROVIDER_API_KEY: FakeOpenAiProvider.apiKey,
            COPILOT_PROVIDER_BASE_URL: `${provider.origin}/v1`,
            COPILOT_PROVIDER_MODEL_ID: provider.model,
            COPILOT_PROVIDER_TYPE: "openai",
            COPILOT_PROVIDER_WIRE_MODEL: provider.model,
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_CODEX_ACP_PATH: missing,
            MOBIUS_COPILOT_PATH: executable,
            MOBIUS_CURSOR_PATH: missing,
            MOBIUS_DEEPSEEK_HARNESS_PATH: missing,
            MOBIUS_GEMINI_PATH: missing,
            MOBIUS_GROK_BUILD_PATH: missing,
            MOBIUS_HERMES_PATH: missing,
            MOBIUS_OPENCODE_PATH: missing,
            MOBIUS_PI_PATH: missing,
            MOBIUS_PI_ACP_PATH: missing,
            MOBIUS_WORKBUDDY_PATH: missing,
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
