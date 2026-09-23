import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { ClaudeFixture } from "../tests/agent-daemon/infra/claude.ts";
import { CodexFixture } from "../tests/agent-daemon/infra/codex.ts";
import { CopilotFixture } from "../tests/agent-daemon/infra/copilot.ts";
import { CursorFixture } from "../tests/agent-daemon/infra/cursor.ts";
import { DeepSeekFixture } from "../tests/agent-daemon/infra/deepseek.ts";
import { GeminiFixture } from "../tests/agent-daemon/infra/gemini.ts";
import { GrokFixture } from "../tests/agent-daemon/infra/grok.ts";
import { HermesFixture } from "../tests/agent-daemon/infra/hermes.ts";
import { OpenCodeFixture } from "../tests/agent-daemon/infra/opencode.ts";
import { PiFixture } from "../tests/agent-daemon/infra/pi.ts";
import { WorkBuddyFixture } from "../tests/agent-daemon/infra/workbuddy.ts";
import { FakeAnthropicProvider } from "../tests/agent-daemon/providers/anthropic.ts";
import { FakeCursorProvider } from "../tests/agent-daemon/providers/cursor.ts";
import { FakeGeminiProvider } from "../tests/agent-daemon/providers/gemini.ts";
import { FakeOpenAiProvider } from "../tests/agent-daemon/providers/openai.ts";

interface Disposable {
    [Symbol.asyncDispose](): Promise<void>;
}

interface AgentFixture extends Disposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
}

interface AgentSession {
    readonly arguments?: readonly string[];
    readonly executable?: string;
    readonly fixture: AgentFixture;
    readonly provider: Disposable & { readonly origin: string };
}

type AgentFactory = () => Promise<AgentSession>;
type LaunchTarget = "agent" | "daemon";

const openAiAgent = (
    model: string,
    name: string,
    createFixture: (provider: FakeOpenAiProvider) => Promise<AgentFixture>,
): AgentFactory => {
    return async () => {
        const provider = await FakeOpenAiProvider.start(model, `Response from ${name} through the local fake provider`);
        try {
            return { fixture: await createFixture(provider), provider };
        } catch (error) {
            await provider[Symbol.asyncDispose]();
            throw error;
        }
    };
};

const agents = {
    claude: async (): Promise<AgentSession> => {
        const provider = await FakeAnthropicProvider.start(
            "claude-sonnet-4-6",
            "Response from Claude Code through the local fake provider",
        );
        try {
            return { fixture: await ClaudeFixture.create(provider, { requireAdapter: false }), provider };
        } catch (error) {
            await provider[Symbol.asyncDispose]();
            throw error;
        }
    },
    codex: openAiAgent("gpt-5.6-sol", "Codex", CodexFixture.create),
    copilot: openAiAgent("gpt-4.1", "GitHub Copilot CLI", CopilotFixture.create),
    cursor: async (): Promise<AgentSession> => {
        const provider = await FakeCursorProvider.start();
        try {
            const fixture = await CursorFixture.create(provider);
            return {
                arguments: ["--disable-auto-update", "--authless", "--agent-endpoint", provider.agentOrigin],
                executable: fixture.cliExecutable,
                fixture,
                provider,
            };
        } catch (error) {
            await provider[Symbol.asyncDispose]();
            throw error;
        }
    },
    deepseek: openAiAgent("deepseek-chat", "DeepSeek Harness", DeepSeekFixture.create),
    gemini: async (): Promise<AgentSession> => {
        const provider = await FakeGeminiProvider.start("Response from Gemini through the local fake provider");
        try {
            return { fixture: await GeminiFixture.create(provider), provider };
        } catch (error) {
            await provider[Symbol.asyncDispose]();
            throw error;
        }
    },
    grok: openAiAgent("grok-build", "Grok Build", GrokFixture.create),
    hermes: openAiAgent("mobius-test-model", "Hermes", HermesFixture.create),
    opencode: openAiAgent("mobius-test-model", "OpenCode", OpenCodeFixture.create),
    pi: openAiAgent("gpt-5.5", "Pi", async (provider) => await PiFixture.create(provider, { requireAdapter: false })),
    workbuddy: openAiAgent("mobius-workbuddy", "WorkBuddy", WorkBuddyFixture.create),
} satisfies Readonly<Record<string, AgentFactory>>;

type AgentName = keyof typeof agents;

function usage(): string {
    return [
        "Start a real Agent against the local fake LLM provider used by integration tests.",
        "",
        "Usage:",
        "  pnpm dev:agent <agent> [-- <agent arguments...>]",
        "  pnpm dev:agent <agent> --daemon -- <mobius pair or start arguments...>",
        "",
        `Agents: ${Object.keys(agents).join(", ")}`,
        "",
        "Examples:",
        "  pnpm dev:agent claude",
        '  pnpm dev:agent codex -- exec "say hello"',
        "  pnpm dev:agent claude --daemon -- pair --url http://127.0.0.1:8787 --pairing <id> --code <code>",
    ].join("\n");
}

function isAgentName(value: string): value is AgentName {
    return Object.hasOwn(agents, value);
}

async function run(): Promise<void> {
    const commandArguments = process.argv.slice(2);
    const [requestedAgent, ...rawArguments] = commandArguments;
    if (requestedAgent === undefined || requestedAgent === "--help" || requestedAgent === "-h") {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    if (!isAgentName(requestedAgent)) {
        throw new Error(`Unknown Agent ${JSON.stringify(requestedAgent)}\n\n${usage()}`);
    }
    const target: LaunchTarget = rawArguments[0] === "--daemon" ? "daemon" : "agent";
    const rawAgentArguments = target === "daemon" ? rawArguments.slice(1) : rawArguments;
    const agentArguments = rawAgentArguments[0] === "--" ? rawAgentArguments.slice(1) : rawAgentArguments;
    if (target === "daemon" && agentArguments.length === 0) {
        throw new Error(usage());
    }

    const session = await agents[requestedAgent]();
    try {
        let executable = session.executable ?? session.fixture.executable;
        let arguments_ = [...(session.arguments ?? []), ...agentArguments];
        if (target === "daemon") {
            executable = process.execPath;
            arguments_ = [resolve(import.meta.dirname, "../packages/cli/src/cli.ts"), ...agentArguments];
        }
        const environment = { ...process.env, ...session.fixture.environment };
        if (target === "daemon") {
            environment["MOBIUS_STATE_DIRECTORY"] = resolve(
                import.meta.dirname,
                `../.mobius/dev-agents/${requestedAgent}`,
            );
            if (requestedAgent === "claude") {
                delete environment["MOBIUS_CLAUDE_ACP_PATH"];
            }
            if (requestedAgent === "pi") {
                delete environment["MOBIUS_PI_ACP_PATH"];
            }
        }
        const description = target === "daemon" ? "production Mobius daemon" : `real ${requestedAgent}`;
        process.stderr.write(`Starting ${description} with fake provider ${session.provider.origin}\n`);
        const child = spawn(executable, arguments_, {
            cwd: process.cwd(),
            env: environment,
            stdio: "inherit",
        });
        const forward = (signal: NodeJS.Signals): void => {
            child.kill(signal);
        };
        process.once("SIGINT", forward);
        process.once("SIGTERM", forward);
        try {
            const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
                (resolve, reject) => {
                    child.once("error", reject);
                    child.once("exit", (code, signal) => resolve({ code, signal }));
                },
            );
            if (result.signal !== null) {
                process.exitCode = result.signal === "SIGINT" ? 130 : 1;
            } else {
                process.exitCode = result.code ?? 1;
            }
        } finally {
            process.off("SIGINT", forward);
            process.off("SIGTERM", forward);
        }
    } finally {
        try {
            await session.fixture[Symbol.asyncDispose]();
        } finally {
            await session.provider[Symbol.asyncDispose]();
        }
    }
}

await run();
