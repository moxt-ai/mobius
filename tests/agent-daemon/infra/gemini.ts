import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGeminiProvider } from "../providers/gemini.ts";
import { resolveTestExecutable } from "./executable.ts";

export class GeminiFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeGeminiProvider): Promise<GeminiFixture> {
        const executable = await resolveTestExecutable("gemini", "MOBIUS_TEST_GEMINI_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-gemini-"));
        const configDirectory = join(directory, ".gemini");
        const missing = join(directory, "missing-agent");
        await mkdir(configDirectory, { recursive: true });
        await writeFile(
            join(configDirectory, "settings.json"),
            `${JSON.stringify(
                {
                    general: { enableAutoUpdate: false },
                    security: {
                        auth: { selectedType: "gemini-api-key" },
                        folderTrust: { enabled: false },
                    },
                },
                null,
                2,
            )}\n`,
            { mode: 0o600 },
        );
        return new GeminiFixture(directory, executable, {
            GEMINI_API_KEY: FakeGeminiProvider.apiKey,
            GOOGLE_GEMINI_BASE_URL: provider.origin,
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_CODEX_ACP_PATH: missing,
            MOBIUS_COPILOT_PATH: missing,
            MOBIUS_CURSOR_PATH: missing,
            MOBIUS_DEEPSEEK_HARNESS_PATH: missing,
            MOBIUS_GEMINI_PATH: executable,
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
