import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    static async create(provider: FakeAnthropicProvider): Promise<ClaudeFixture> {
        return await ClaudeFixture.createWithAuthentication({
            ANTHROPIC_API_KEY: FakeAnthropicProvider.apiKey,
            ANTHROPIC_BASE_URL: provider.origin,
            ANTHROPIC_MODEL: provider.model,
        });
    }

    static async createExpiredOAuth(): Promise<ClaudeFixture> {
        const fixture = await ClaudeFixture.createWithAuthentication({
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
        });
        try {
            const config = join(fixture.#directory, "claude");
            await mkdir(config, { recursive: true });
            await writeFile(
                join(config, ".credentials.json"),
                JSON.stringify({
                    claudeAiOauth: {
                        accessToken: "",
                        refreshToken: "",
                        expiresAt: 0,
                        refreshTokenExpiresAt: 0,
                        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
                        subscriptionType: "max",
                    },
                }),
            );
            return fixture;
        } catch (cause) {
            await fixture[Symbol.asyncDispose]();
            throw cause;
        }
    }

    private static async createWithAuthentication(
        authentication: Readonly<Record<string, string>>,
    ): Promise<ClaudeFixture> {
        const executable = await resolveTestExecutable("claude", "MOBIUS_TEST_CLAUDE_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-claude-"));
        const missing = join(directory, "missing-agent");
        return new ClaudeFixture(directory, executable, {
            ...authentication,
            CLAUDE_CONFIG_DIR: join(directory, "claude"),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            HOME: directory,
            ...(process.platform === "win32" ? { USERPROFILE: directory } : {}),
            MOBIUS_CLAUDE_PATH: executable,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_PI_PATH: missing,
            NO_BROWSER: "1",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
}
