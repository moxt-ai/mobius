import { ClaudeAcpEndpoint } from "../../acp/harness/claude/endpoint.ts";
import type { InProcessAcpEndpointFactory } from "../../acp/in-process/acp-endpoint.ts";
import { InProcessAcpAgentDefinition } from "../agent-specification.ts";

export class ClaudeCodeAgentSpecification extends InProcessAcpAgentDefinition {
    readonly agentExecutable = "claude";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new ClaudeAcpEndpoint(options);
    readonly id = "claude";
    readonly label = "Claude Code";
    override readonly minimumSupportedAgentVersion = "2.1.273";
    override readonly maximumTestedAgentVersion = "2.1.273";

    constructor() {
        super("MOBIUS_CLAUDE_PATH", ["agents", "claude", "home", ".local", "bin", "claude"]);
    }
}
