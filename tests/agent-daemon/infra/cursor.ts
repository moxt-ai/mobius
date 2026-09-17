import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCursorProvider } from "../providers/cursor.ts";
import { resolveTestExecutable } from "./executable.ts";

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class CursorFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly stderrPath: string;
    readonly #directory: string;

    private constructor(
        directory: string,
        executable: string,
        stderrPath: string,
        environment: Readonly<Record<string, string>>,
    ) {
        this.#directory = directory;
        this.executable = executable;
        this.stderrPath = stderrPath;
        this.environment = environment;
    }

    static async create(cursorProvider: FakeCursorProvider): Promise<CursorFixture> {
        const cursor = await resolveTestExecutable("cursor-agent-local", "MOBIUS_TEST_CURSOR_LOCAL_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-cursor-"));
        const executable = join(directory, "cursor-agent");
        const stderrPath = join(directory, "cursor-agent.stderr.log");
        const missing = join(directory, "missing-agent");
        await writeFile(
            executable,
            [
                "#!/bin/sh",
                `if [ "${"$"}1" = "--version" ]; then exec ${shellQuote(cursor)} "${"$"}@"; fi`,
                `if [ "${"$"}#" -ne 2 ] || [ "${"$"}1" != "--disable-auto-update" ] || [ "${"$"}2" != "acp" ]; then exit 81; fi`,
                `exec ${shellQuote(cursor)} --disable-auto-update --debug --stderr --authless --agent-endpoint ${shellQuote(cursorProvider.agentOrigin)} acp 2>>${shellQuote(stderrPath)}`,
                "",
            ].join("\n"),
            { mode: 0o700 },
        );
        await chmod(executable, 0o700);
        return new CursorFixture(directory, executable, stderrPath, {
            AGENT_CLI_CREDENTIAL_STORE: "file",
            CURSOR_AGENT_CLI_AUTHLESS_MODE: "true",
            CURSOR_API_ENDPOINT: cursorProvider.origin,
            CURSOR_API_KEY: "unused",
            HOME: directory,
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CLAUDE_ACP_PATH: missing,
            MOBIUS_CODEX_PATH: missing,
            MOBIUS_CODEX_ACP_PATH: missing,
            MOBIUS_COPILOT_PATH: missing,
            MOBIUS_CURSOR_PATH: executable,
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
