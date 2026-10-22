import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { ClaudeFixture } from "../packages/cli/tests/support/agents/claude.ts";
import { CodexFixture } from "../packages/cli/tests/support/agents/codex.ts";
import { PiFixture } from "../packages/cli/tests/support/agents/pi.ts";
import { FakeAnthropicProvider } from "../packages/cli/tests/support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../packages/cli/tests/support/llm/openai.ts";

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
            return { fixture: await ClaudeFixture.create(provider), provider };
        } catch (error) {
            await provider[Symbol.asyncDispose]();
            throw error;
        }
    },
    codex: openAiAgent("gpt-5.6-sol", "Codex", CodexFixture.create),
    pi: openAiAgent("gpt-5.5", "Pi", PiFixture.create),
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
            arguments_ = [resolve(import.meta.dirname, "../packages/cli/src/cli/entrypoint.ts"), ...agentArguments];
        }
        const environment = { ...process.env, ...session.fixture.environment };
        if (target === "daemon") {
            environment["MOBIUS_STATE_DIRECTORY"] = resolve(
                import.meta.dirname,
                `../.mobius/dev-agents/${requestedAgent}`,
            );
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
