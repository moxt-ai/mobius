import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const agentDaemonConfigurations = [
    { agent: "opencode", packages: "opencode-ai@1.18.29" },
    { agent: "codex", packages: "@openai/codex@0.154.0 @agentclientprotocol/codex-acp@1.12.0" },
    { agent: "pi", packages: "@earendil-works/pi-coding-agent@0.85.0 pi-acp@0.0.33" },
    { agent: "gemini", packages: "@google/gemini-cli@0.59.0" },
    { agent: "claude", packages: "@anthropic-ai/claude-code@2.1.273 @agentclientprotocol/claude-agent-acp@0.73.0" },
    { agent: "deepseek", packages: "@deepseek-ai/dsh@0.1.2-rc.1" },
    { agent: "hermes", packages: "" },
    { agent: "grok", packages: "@xai-official/grok@1.0.21" },
];

const allAgents = agentDaemonConfigurations.map(({ agent }) => agent);
const openAiAgents = ["opencode", "codex", "pi", "deepseek", "hermes", "grok"];
const agentFiles = new Map(
    [
        ["claude", "claude-code-agent"],
        ["codex", "codex-agent"],
        ["deepseek", "deepseek-harness-agent"],
        ["gemini", "gemini-cli-agent"],
        ["hermes", "hermes-agent"],
        ["grok", "grok-build-agent"],
        ["opencode", "opencode-agent"],
        ["pi", "pi-agent"],
    ].flatMap(([agent, specification]) => [
        [`tests/agent-daemon/cases/${agent}.integration.test.ts`, agent],
        [`tests/agent-daemon/infra/${agent}.ts`, agent],
        [`packages/cli/src/agent-catalog/agents/${specification}.ts`, agent],
    ]),
);

const sharedFiles = new Set([
    ".github/workflows/ci.yml",
    ".nvmrc",
    "e2e/support/standalone.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/plan-agent-daemon-tests.mjs",
    "scripts/plan-agent-daemon-tests.test.mjs",
    "scripts/worktree/environment.ts",
    "scripts/wrangler.ts",
    "tests/agent-daemon/infra/executable.ts",
    "vitest.agent-daemon.config.ts",
    "packages/relay-cloudflare-standalone/wrangler.jsonc",
]);

const sharedPrefixes = [
    "packages/cli/src/",
    "packages/mobius-sdk/src/",
    "packages/protocol/src/",
    "packages/relay-core/src/",
    "packages/relay-cloudflare-standalone/src/",
    "packages/relay-cloudflare-standalone/migrations/",
];

function addAgents(selected, reasons, agents, reason) {
    for (const agent of agents) {
        selected.add(agent);
        const current = reasons.get(agent) ?? [];
        current.push(reason);
        reasons.set(agent, current);
    }
}

export function selectAgentDaemonTests(changedFiles) {
    const selected = new Set();
    const reasons = new Map();
    for (const file of changedFiles) {
        if (file.endsWith(".md")) {
            continue;
        }
        const ownedAgent = agentFiles.get(file);
        if (ownedAgent !== undefined) {
            addAgents(selected, reasons, [ownedAgent], file);
            continue;
        }
        if (file === "tests/agent-daemon/providers/openai.ts") {
            addAgents(selected, reasons, openAiAgents, file);
            continue;
        }
        if (file === "tests/agent-daemon/providers/anthropic.ts") {
            addAgents(selected, reasons, ["claude"], file);
            continue;
        }
        if (file === "tests/agent-daemon/providers/gemini.ts") {
            addAgents(selected, reasons, ["gemini"], file);
            continue;
        }
        if (
            sharedFiles.has(file) ||
            sharedPrefixes.some((prefix) => file.startsWith(prefix)) ||
            file.startsWith("tests/agent-daemon/") ||
            /^(?:packages\/(?:cli|mobius-sdk|protocol|relay-core|relay-cloudflare-standalone)|tests)\/(?:package\.json|tsconfig(?:\.[^/]+)?\.json)$/u.test(
                file,
            )
        ) {
            addAgents(selected, reasons, allAgents, file);
        }
    }
    return {
        agents: agentDaemonConfigurations.filter(({ agent }) => selected.has(agent)),
        reasons,
    };
}

function changedFiles(base, head) {
    if (base.length === 0) {
        return { files: [], full: true, reason: "No base revision was provided" };
    }
    const result = spawnSync("git", ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`], {
        encoding: "utf8",
    });
    if (result.status !== 0) {
        return {
            files: [],
            full: true,
            reason: `Could not diff ${base}...${head}: ${(result.stderr || "git diff failed").trim()}`,
        };
    }
    const fields = result.stdout.split("\0");
    const files = [];
    for (let index = 0; index < fields.length - 1; ) {
        const status = fields[index++];
        if (status.startsWith("R") || status.startsWith("C")) {
            files.push(fields[index++], fields[index++]);
        } else {
            files.push(fields[index++]);
        }
    }
    return { files: [...new Set(files)], full: false, reason: "" };
}

function argument(name, fallback = "") {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function writePlan(plan, files, fallbackReason) {
    const matrix = JSON.stringify({ include: plan.agents });
    const output = argument("--github-output", process.env.GITHUB_OUTPUT ?? "");
    if (output.length > 0) {
        appendFileSync(output, `matrix=${matrix}\ncount=${plan.agents.length.toString()}\n`);
    }
    const lines = [
        "## Agent and daemon test plan",
        "",
        fallbackReason.length > 0 ? `Fallback: ${fallbackReason}` : `Changed files: ${files.length.toString()}`,
        "",
    ];
    if (plan.agents.length === 0) {
        lines.push("No agent and daemon tests are affected.");
    } else {
        for (const { agent } of plan.agents) {
            const reasons = [...new Set(plan.reasons.get(agent) ?? [fallbackReason])];
            lines.push(`- ${agent}: ${reasons.join(", ")}`);
        }
    }
    const summary = `${lines.join("\n")}\n`;
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const base = argument("--base");
    const head = argument("--head", "HEAD");
    const changes = changedFiles(base, head);
    const plan = changes.full
        ? {
              agents: agentDaemonConfigurations,
              reasons: new Map(allAgents.map((agent) => [agent, [changes.reason]])),
          }
        : selectAgentDaemonTests(changes.files);
    writePlan(plan, changes.files, changes.reason);
}
