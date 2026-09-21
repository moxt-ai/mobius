import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectAgentDaemonTests } from "./plan-agent-daemon-tests.mjs";

function selected(files) {
    return selectAgentDaemonTests(files).agents.map(({ agent }) => agent);
}

describe("agent and daemon test planning", () => {
    it("skips documentation and unrelated UI changes", () => {
        assert.deepEqual(selected(["tests/agent-daemon/README.md", "packages/web/src/app.tsx"]), []);
    });

    it("selects one Agent for its case, fixture, or production specification", () => {
        assert.deepEqual(selected(["tests/agent-daemon/real/copilot.integration.test.ts"]), ["copilot"]);
        assert.deepEqual(selected(["tests/agent-daemon/providers/cursor.ts"]), ["cursor"]);
        assert.deepEqual(selected(["packages/cli/src/agent-catalog/agents/copilot-cli-agent.ts"]), ["copilot"]);
        assert.deepEqual(selected(["tests/agent-daemon/real/hermes.integration.test.ts"]), ["hermes"]);
        assert.deepEqual(selected(["packages/cli/src/agent-catalog/agents/gemini-cli-agent.ts"]), ["gemini"]);
        assert.deepEqual(selected(["packages/cli/src/agent-catalog/agents/grok-build-agent.ts"]), ["grok"]);
    });

    it("selects one Agent for the in-process protocol it owns", () => {
        assert.deepEqual(selected(["packages/cli/src/acp/codex/agent.ts"]), ["codex"]);
        assert.deepEqual(selected(["packages/cli/src/acp/codex/app-server-client.ts"]), ["codex"]);
    });

    it("selects every OpenAI-compatible Agent for their shared fake provider", () => {
        assert.deepEqual(selected(["tests/agent-daemon/providers/openai.ts"]), [
            "opencode",
            "codex",
            "copilot",
            "pi",
            "deepseek",
            "hermes",
            "grok",
            "workbuddy",
        ]);
    });

    it("selects all Agents for shared production and test infrastructure", () => {
        const all = [
            "opencode",
            "codex",
            "copilot",
            "cursor",
            "pi",
            "gemini",
            "claude",
            "deepseek",
            "hermes",
            "grok",
            "workbuddy",
        ];
        assert.deepEqual(selected(["packages/cli/src/acp/session-manager.ts"]), all);
        assert.deepEqual(selected(["tests/agent-daemon/new-shared-helper.ts"]), all);
        assert.deepEqual(selected([".github/actions/setup/action.yml"]), all);
        assert.deepEqual(selected(["scripts/plan-agent-daemon-tests.mjs"]), all);
    });

    it("does not rerun real Agents for fake-only scenarios", () => {
        assert.deepEqual(
            selected(["tests/agent-daemon/controlled-agent/acp-session-features.integration.test.ts"]),
            [],
        );
        assert.deepEqual(selected(["tests/agent-daemon/fixtures/fake-acp-agent/src/cli.ts"]), []);
    });
});
