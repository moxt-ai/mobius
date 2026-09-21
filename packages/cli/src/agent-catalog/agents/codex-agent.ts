import { CodexAcpAgent } from "../../acp/codex/agent.ts";
import type { InProcessAcpEndpointFactory } from "../../acp/in-process/acp-endpoint.ts";
import { InProcessAcpAgentDefinition } from "../agent-specification.ts";

// Codex speaks its own app-server protocol rather than ACP, so Mobius hosts the ACP Agent in-process
// and drives `codex app-server` directly. There is no adapter package to install or version-probe.
export class CodexAgentSpecification extends InProcessAcpAgentDefinition {
    override readonly versionProbeTimeoutMilliseconds = 10_000;
    readonly agentExecutable = "codex";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new CodexAcpAgent(options);
    readonly id = "codex";
    readonly label = "Codex";

    constructor() {
        super("MOBIUS_CODEX_PATH", ["agents", "codex", "bin", "codex"]);
    }
}
