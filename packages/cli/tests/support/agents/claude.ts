import { addAbortListener } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listEnvironmentSessions } from "../../../src/engine/acp/harness/claude/upstream/dist/environment-session-list.js";
import {
    type EnvironmentSessionMessage,
    getEnvironmentSessionMessages,
} from "../../../src/engine/acp/harness/claude/upstream/dist/environment-session-messages.js";
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

    static async create(provider: Pick<FakeAnthropicProvider, "origin" | "model">): Promise<ClaudeFixture> {
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

    /**
     * Returns the session's saved messages once its native transcript contains
     * `messageId`. Prompt completion is a live-output boundary, not a transcript
     * flush: Claude Code may write a turn's messages, and even create the
     * transcript, after the turn completes. Native writes are observed instead of
     * assuming a completed prompt saved them.
     */
    async waitForSavedMessage(
        sessionId: string,
        messageId: string,
        signal: AbortSignal,
    ): Promise<readonly EnvironmentSessionMessage[]> {
        const configDirectory = this.environment["CLAUDE_CONFIG_DIR"];
        if (configDirectory === undefined) {
            throw new Error("Expected an isolated Claude configuration directory");
        }
        type NativeWrite = { readonly kind: "changed" } | { readonly kind: "failed"; readonly cause: Error };
        let changed = Promise.withResolvers<NativeWrite>();
        const watcher = watch(configDirectory, { recursive: true }, () => changed.resolve({ kind: "changed" }));
        watcher.on("error", (cause) => changed.resolve({ kind: "failed", cause }));
        using _abort = addAbortListener(signal, () => changed.resolve({ kind: "changed" }));
        try {
            for (;;) {
                signal.throwIfAborted();
                // Subscribe before reading so a write during the read is not missed.
                const notification = changed.promise;
                const sessions = await listEnvironmentSessions(this.environment, undefined, signal);
                if (sessions.some((session) => session.sessionId === sessionId)) {
                    const saved = await getEnvironmentSessionMessages(this.environment, sessionId, signal);
                    if (saved.some((message) => message.uuid === messageId)) {
                        return saved;
                    }
                }
                const event = await notification;
                if (event.kind === "failed") {
                    throw event.cause;
                }
                changed = Promise.withResolvers<NativeWrite>();
            }
        } finally {
            watcher.close();
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
}
