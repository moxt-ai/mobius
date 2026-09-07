import type { LocalAgentSpecification } from "../agent-specification.ts";
import { ClaudeCodeAgentSpecification } from "./claude-code-agent.ts";
import { CodexAgentSpecification } from "./codex-agent.ts";
import { CursorCliAgentSpecification } from "./cursor-cli-agent.ts";
import { DeepSeekHarnessAgentSpecification } from "./deepseek-harness-agent.ts";
import { GrokBuildAgentSpecification } from "./grok-build-agent.ts";
import { OpenCodeAgentSpecification } from "./opencode-agent.ts";
import { PiAgentSpecification } from "./pi-agent.ts";
import { WorkBuddyAgentSpecification } from "./workbuddy-agent.ts";

export function supportedLocalAgentSpecifications(): readonly LocalAgentSpecification[] {
  return Object.freeze([
    new CodexAgentSpecification(),
    new ClaudeCodeAgentSpecification(),
    new PiAgentSpecification(),
    new DeepSeekHarnessAgentSpecification(),
    new OpenCodeAgentSpecification(),
    new CursorCliAgentSpecification(),
    new GrokBuildAgentSpecification(),
    new WorkBuddyAgentSpecification(),
  ]);
}
