import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { FakeOpenAiProvider } from "../providers/openai.ts";

async function executableOnPath(name: string): Promise<string | null> {
    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
        if (directory.length === 0) {
            continue;
        }
        const candidate = join(directory, process.platform === "win32" ? `${name}.exe` : name);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Keep searching PATH.
        }
    }
    return null;
}

export class OpenCodeFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<OpenCodeFixture> {
        const configured = process.env["MOBIUS_TEST_OPENCODE_PATH"];
        const executable = configured === undefined ? await executableOnPath("opencode") : resolve(configured);
        if (executable === null) {
            throw new Error("Real OpenCode is required; set MOBIUS_TEST_OPENCODE_PATH or put opencode on PATH");
        }
        await access(executable, constants.X_OK);
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-opencode-"));
        const configHome = join(directory, "config");
        const configDirectory = join(configHome, "opencode");
        const missing = join(directory, "missing-agent");
        await mkdir(configDirectory, { recursive: true });
        await writeFile(
            join(configDirectory, "opencode.json"),
            `${JSON.stringify(
                {
                    model: `mobius/${FakeOpenAiProvider.model}`,
                    provider: {
                        mobius: {
                            models: {
                                [FakeOpenAiProvider.model]: { name: "Mobius test model" },
                            },
                            name: "Mobius fake provider",
                            npm: "@ai-sdk/openai-compatible",
                            options: {
                                apiKey: FakeOpenAiProvider.apiKey,
                                baseURL: `${provider.origin}/v1`,
                            },
                        },
                    },
                },
                null,
                2,
            )}\n`,
            { mode: 0o600 },
        );
        return new OpenCodeFixture(directory, executable, {
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
            MOBIUS_OPENCODE_PATH: executable,
            MOBIUS_PI_PATH: missing,
            MOBIUS_PI_ACP_PATH: missing,
            MOBIUS_WORKBUDDY_PATH: missing,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: configHome,
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, recursive: true });
    }
}
