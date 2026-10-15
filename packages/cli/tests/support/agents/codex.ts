import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executableLaunch } from "../../../src/util/process/executable.ts";
import { FakeOpenAiProvider } from "../llm/openai.ts";
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

    static async create(
        provider: FakeOpenAiProvider,
        options: {
            readonly approvalPolicy?: "never" | "on-request";
            readonly configuredModel?: string;
        } = {},
    ): Promise<CodexFixture> {
        // Codex is an in-process Agent: there is no ACP adapter to resolve, only the real binary
        // that Mobius drives through `codex app-server`.
        const executable = await resolveTestExecutable("codex", "MOBIUS_TEST_CODEX_PATH");
        const directory = await mkdtemp(join(tmpdir(), "mobius-agent-daemon-codex-"));
        const codexHome = join(directory, "codex");
        const missing = join(directory, "missing-agent");
        await mkdir(codexHome, { recursive: true });
        await writeFile(
            join(codexHome, "config.toml"),
            [
                ...(options.configuredModel === undefined
                    ? []
                    : [`model = ${JSON.stringify(options.configuredModel)}`]),
                'model_provider = "mobius"',
                'model_reasoning_effort = "low"',
                'model_reasoning_summary = "none"',
                // The CI host cannot create the sandbox namespaces Codex needs, so the fixture runs
                // its tool calls without one. This is Codex configuration, not Mobius policy.
                'sandbox_mode = "danger-full-access"',
                `approval_policy = ${JSON.stringify(options.approvalPolicy ?? "never")}`,
                "",
                "[model_providers.mobius]",
                'name = "Mobius fake provider"',
                `base_url = ${JSON.stringify(`${provider.origin}/v1`)}`,
                'env_key = "CODEX_API_KEY"',
                'wire_api = "responses"',
                "request_max_retries = 0",
                "stream_max_retries = 0",
                "supports_websockets = false",
                "",
                "[features]",
                "plugins = false",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        return new CodexFixture(directory, executable, {
            CODEX_API_KEY: FakeOpenAiProvider.apiKey,
            CODEX_HOME: codexHome,
            DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
            HOME: directory,
            INITIAL_AGENT_MODE: "agent-full-access",
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CODEX_PATH: executable,
            MOBIUS_PI_PATH: missing,
            NO_PROXY: "127.0.0.1,localhost",
            NO_BROWSER: "1",
            PATH: process.env["PATH"] ?? "",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
            no_proxy: "127.0.0.1,localhost",
        });
    }

    async writeLauncher(path: string): Promise<void> {
        const launch = executableLaunch(this.executable, []);
        await writeFile(
            path,
            `#!${process.execPath}
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ...${JSON.stringify(this.environment)} } });
child.once("error", () => process.exit(1));
child.once("exit", (code) => process.exit(code ?? 1));
`,
            { mode: 0o700 },
        );
    }

    async rolloutDiagnostics(): Promise<readonly unknown[]> {
        const sessions = join(this.#directory, "codex", "sessions");
        const files = await jsonlFiles(sessions);
        const diagnostics: unknown[] = [];
        for (const file of files) {
            const lines = (await readFile(file, "utf8")).split("\n");
            for (const [index, line] of lines.entries()) {
                if (!/(?:custom_tool_call|function_call|tool_call)/u.test(line)) {
                    continue;
                }
                diagnostics.push({ file: file.slice(sessions.length + 1), line: index + 1, record: JSON.parse(line) });
            }
        }
        return diagnostics;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
}

async function jsonlFiles(directory: string): Promise<readonly string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const nested = await Promise.all(
        entries.map((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? jsonlFiles(path) : Promise.resolve(path.endsWith(".jsonl") ? [path] : []);
        }),
    );
    return nested.flat();
}
