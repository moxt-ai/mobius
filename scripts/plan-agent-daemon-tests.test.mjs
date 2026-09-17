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
        assert.deepEqual(selected(["tests/agent-daemon/cases/hermes.integration.test.ts"]), ["hermes"]);
        assert.deepEqual(selected(["packages/cli/src/agent-catalog/agents/gemini-cli-agent.ts"]), ["gemini"]);
        assert.deepEqual(selected(["packages/cli/src/agent-catalog/agents/grok-build-agent.ts"]), ["grok"]);
    });

    it("selects every OpenAI-compatible Agent for their shared fake provider", () => {
        assert.deepEqual(selected(["tests/agent-daemon/providers/openai.ts"]), [
            "opencode",
            "codex",
            "pi",
            "deepseek",
            "hermes",
            "grok",
        ]);
    });

    it("selects all Agents for shared production and test infrastructure", () => {
        const all = ["opencode", "codex", "pi", "gemini", "claude", "deepseek", "hermes", "grok"];
        assert.deepEqual(selected(["packages/cli/src/acp/session-manager.ts"]), all);
        assert.deepEqual(selected(["tests/agent-daemon/new-shared-helper.ts"]), all);
        assert.deepEqual(selected(["scripts/plan-agent-daemon-tests.mjs"]), all);
    });
});
