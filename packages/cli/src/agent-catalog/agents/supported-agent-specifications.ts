import type { LocalAgentSpecification } from "../agent-specification.ts";
import { ClaudeCodeAgentSpecification } from "./claude-code-agent.ts";
import { CodexAgentSpecification } from "./codex-agent.ts";
import { PiAgentSpecification } from "./pi-agent.ts";

export function supportedLocalAgentSpecifications(): readonly LocalAgentSpecification[] {
    return Object.freeze([
        new CodexAgentSpecification(),
        new ClaudeCodeAgentSpecification(),
        new PiAgentSpecification(),
    ]);
}
