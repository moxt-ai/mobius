import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenAiProvider } from "../llm/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class PiFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<PiFixture> {
        const executable = await resolveTestExecutable("pi", "MOBIUS_TEST_PI_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-pi-"));
        const configDirectory = join(directory, ".pi", "agent");
        const missing = join(directory, "missing-agent");
        await mkdir(configDirectory, { recursive: true });
        await Promise.all([
            writeFile(
                join(configDirectory, "models.json"),
                `${JSON.stringify({ providers: { openai: { baseUrl: `${provider.origin}/v1` } } }, null, 2)}\n`,
                { mode: 0o600 },
            ),
            writeFile(
                join(configDirectory, "settings.json"),
                `${JSON.stringify(
                    {
                        defaultModel: provider.model,
                        defaultProvider: "openai",
                        defaultThinkingLevel: "off",
                        enableInstallTelemetry: false,
                        quietStartup: true,
                        transport: "sse",
                    },
                    null,
                    2,
                )}\n`,
                { mode: 0o600 },
            ),
        ]);
        return new PiFixture(directory, executable, {
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_PI_PATH: executable,
            NO_BROWSER: "1",
            OPENAI_API_KEY: FakeOpenAiProvider.apiKey,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
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
